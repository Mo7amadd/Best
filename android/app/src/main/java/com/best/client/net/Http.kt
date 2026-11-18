package com.best.client.net

import com.best.client.vpn.VpnState
import java.io.Closeable
import java.io.FilterInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * A small HTTP/1.1 client for Best's own requests (subscriptions, update checks, downloads,
 * WebDAV). While connected, every request goes through the connection (a SOCKS inbound of the
 * running Xray with a random password), so the server sees the proxy's address, not the phone's,
 * and a blocked address still works; there is no fallback to a direct request then. Otherwise it
 * connects directly, to the address the caller already checked.
 */
object Http {

    private const val MAX_HEAD = 64 * 1024

    class Response internal constructor(
        val status: Int,
        /** Header names in lower case; the last value of each. */
        val headers: Map<String, String>,
        /** -1 when unknown. */
        val length: Long,
        val body: InputStream,
        private val socket: Socket,
    ) : Closeable {
        fun header(name: String): String? = headers[name.lowercase()]
        override fun close() { try { socket.close() } catch (_: Exception) { } }
    }

    /** True while requests go through the connection. */
    val tunneled: Boolean get() = VpnState.tunnel != null

    /**
     * Sends one request (no redirects followed). `connectTo`: the address to use for a direct
     * connection (already checked by the caller); ignored when tunneled.
     */
    fun request(
        method: String,
        url: URL,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        timeoutMs: Int = 25_000,
        connectTo: InetAddress? = null,
        /** false: always direct (a server in the local network, or the user turned it off). */
        tunnel: Boolean = true,
    ): Response {
        require(url.protocol == "https" || url.protocol == "http") { "BAD_URL" }
        val host = url.host ?: throw IllegalArgumentException("BAD_URL")
        val port = if (url.port > 0) url.port else url.defaultPort
        val via = if (tunnel) VpnState.tunnel else null
        var socket: Socket = if (via != null) {
            Socks.connect(via, host, port, timeoutMs)
        } else {
            Socket().apply {
                connect(InetSocketAddress(connectTo ?: InetAddress.getByName(host), port), timeoutMs)
                soTimeout = timeoutMs
            }
        }
        try {
            if (url.protocol == "https") socket = Socks.tls(socket, host.removePrefix("[").removeSuffix("]"), port, timeoutMs)
            val path = (url.path.ifEmpty { "/" }) + (url.query?.let { "?$it" } ?: "")
            val head = StringBuilder()
                .append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
                .append("Host: ").append(if (port == url.defaultPort) host else "$host:$port").append("\r\n")
                .append("Accept-Encoding: identity\r\n")
                .append("Connection: close\r\n")
            for ((k, v) in headers) {
                require(HEADER.matches(k) && !v.contains('\r') && !v.contains('\n')) { "BAD_ARGUMENTS" }
                head.append(k).append(": ").append(v).append("\r\n")
            }
            if (body != null) head.append("Content-Length: ").append(body.size).append("\r\n")
            head.append("\r\n")
            val out = socket.getOutputStream()
            out.write(head.toString().toByteArray(Charsets.UTF_8))
            if (body != null) out.write(body)
            out.flush()

            val input = socket.getInputStream().buffered(16 * 1024)
            val status = readStatus(input)
            val hs = readHeaders(input)
            val chunked = hs["transfer-encoding"]?.lowercase()?.contains("chunked") == true
            val length = if (chunked) -1L else hs["content-length"]?.trim()?.toLongOrNull() ?: -1L
            val stream: InputStream = when {
                method == "HEAD" || status == 204 || status == 304 -> java.io.ByteArrayInputStream(ByteArray(0))
                chunked -> Chunked(input)
                length >= 0 -> Limited(input, length)
                else -> input
            }
            return Response(status, hs, length, stream, socket)
        } catch (e: Exception) {
            try { socket.close() } catch (_: Exception) { }
            throw e
        }
    }

    private val HEADER = Regex("^[A-Za-z0-9-]{1,64}$")

    private fun readLine(input: InputStream): String {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) throw java.io.EOFException("closed")
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
            if (sb.length > MAX_HEAD) throw IllegalStateException("BAD_RESPONSE")
        }
    }

    private fun readStatus(input: InputStream): Int {
        while (true) {
            val line = readLine(input)
            val code = Regex("^HTTP/\\d(?:\\.\\d)? (\\d{3})").find(line)?.groupValues?.get(1)?.toInt() ?: throw IllegalStateException("BAD_RESPONSE")
            if (code != 100) return code
            readHeaders(input) // "100 Continue": the real answer follows
        }
    }

    private fun readHeaders(input: InputStream): Map<String, String> {
        val out = HashMap<String, String>()
        var total = 0
        while (true) {
            val line = readLine(input)
            if (line.isEmpty()) return out
            total += line.length
            if (total > MAX_HEAD || out.size > 200) throw IllegalStateException("BAD_RESPONSE")
            val i = line.indexOf(':')
            if (i > 0) out[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
    }

    /** Exactly `left` bytes. */
    private class Limited(input: InputStream, private var left: Long) : FilterInputStream(input) {
        override fun read(): Int {
            if (left <= 0) return -1
            val c = super.read()
            if (c >= 0) left--
            return c
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
    }

    /** "Transfer-Encoding: chunked". */
    private class Chunked(private val input: InputStream) : InputStream() {
        private var left = 0L
        private var done = false

        private fun next(): Boolean {
            if (done) return false
            if (left > 0) return true
            val line = readLine(input).substringBefore(';').trim()
            val size = line.toLongOrNull(16) ?: throw IllegalStateException("BAD_RESPONSE")
            if (size == 0L) {
                while (readLine(input).isNotEmpty()) { /* trailers */ }
                done = true
                return false
            }
            left = size
            return true
        }

        override fun read(): Int {
            val b = ByteArray(1)
            return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (!next()) return -1
            val n = input.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) throw java.io.EOFException("closed")
            left -= n
            if (left == 0L) readLine(input) // the CRLF after each chunk
            return n
        }
    }
}
