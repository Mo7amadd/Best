package com.best.client.net

import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** SOCKS5 client (user name / password only) for Best's own local inbounds, and TLS on top. */
object Socks {

    /** A SOCKS inbound on 127.0.0.1 with its credentials. */
    class Endpoint(val port: Int, val user: String, val pass: String)

    /** A TCP connection to host:port through the inbound (the name is resolved on the far side). */
    fun connect(p: Endpoint, host: String, port: Int, timeoutMs: Int): Socket {
        val s = Socket()
        try {
            s.connect(InetSocketAddress(Local.LOOPBACK, p.port), 3000)
            s.soTimeout = timeoutMs
            val out = s.getOutputStream()
            val input = s.getInputStream()
            authenticate(out, input, p)
            val name = host.removePrefix("[").removeSuffix("]").toByteArray(Charsets.US_ASCII)
            require(name.size in 1..255) { "BAD_URL" }
            out.write(byteArrayOf(5, 1, 0, 3, name.size.toByte()) + name + byteArrayOf((port shr 8).toByte(), port.toByte()))
            out.flush()
            readReply(input)
            return s
        } catch (e: Exception) {
            s.close()
            throw e
        }
    }

    fun authenticate(out: OutputStream, input: InputStream, p: Endpoint) {
        out.write(byteArrayOf(5, 1, 2)); out.flush()
        val hello = readN(input, 2)
        if (hello[0].toInt() != 5 || hello[1].toInt() != 2) throw IllegalStateException("PROXY_FAILED")
        val u = p.user.toByteArray(); val w = p.pass.toByteArray()
        out.write(byteArrayOf(1, u.size.toByte()) + u + byteArrayOf(w.size.toByte()) + w); out.flush()
        val ok = readN(input, 2)
        if (ok[1].toInt() != 0) throw IllegalStateException("PROXY_FAILED")
    }

    /** Reads a SOCKS5 reply; the bound address (for UDP ASSOCIATE) and port. */
    fun readReply(input: InputStream): Pair<InetAddress?, Int> {
        val head = readN(input, 4)
        if (head[0].toInt() != 5 || head[1].toInt() != 0) throw IllegalStateException("PROXY_FAILED")
        val addr: InetAddress? = when (head[3].toInt()) {
            1 -> InetAddress.getByAddress(readN(input, 4))
            4 -> InetAddress.getByAddress(readN(input, 16))
            3 -> { readN(input, readN(input, 1)[0].toInt() and 0xFF); null }
            else -> throw IllegalStateException("PROXY_FAILED")
        }
        val pb = readN(input, 2)
        return addr to (((pb[0].toInt() and 0xFF) shl 8) or (pb[1].toInt() and 0xFF))
    }

    fun readN(input: InputStream, n: Int): ByteArray {
        val b = ByteArray(n)
        var got = 0
        while (got < n) {
            val r = input.read(b, got, n - got)
            if (r < 0) throw IllegalStateException("PROXY_FAILED")
            got += r
        }
        return b
    }

    /** TLS over a connected socket, with the system's certificates and host name check. */
    fun tls(raw: Socket, host: String, port: Int, timeoutMs: Int = 10_000): Socket {
        val s = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, host, port, true) as SSLSocket
        s.soTimeout = timeoutMs
        s.startHandshake()
        if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, s.session)) {
            s.close()
            throw javax.net.ssl.SSLPeerUnverifiedException("host name")
        }
        return s
    }
}
