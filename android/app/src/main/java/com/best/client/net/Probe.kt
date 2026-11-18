package com.best.client.net

import android.content.Context
import android.os.SystemClock
import com.best.client.vpn.CoreLock
import com.best.client.vpn.SingBox
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import libv2ray.CoreCallbackHandler
import libv2ray.Libv2ray
import org.json.JSONArray
import org.json.JSONObject

/**
 * Speed and UDP tests through one config (and the delay test of sing-box configs). A short-lived
 * core is started with the config's outbound and a SOCKS inbound on 127.0.0.1 with a random port,
 * user name and password (any app on the phone can reach 127.0.0.1, so the inbound is never open to
 * them), used, then stopped: Xray in-process, or sing-box (`core` "singbox") for configs Xray
 * can't open. Best itself is outside the VPN, so a running connection is not involved at all.
 */
object Probe {

    private val seq = java.util.concurrent.atomic.AtomicInteger()

    /** Time until the answer to a request for `url` through the config; ms, or -1. */
    fun delay(ctx: Context, core: String, config: String, url: String, timeoutMs: Int): Long {
        val u = URL(url)
        require(u.protocol == "https" || u.protocol == "http") { "BAD_URL" }
        val host = u.host ?: throw IllegalArgumentException("BAD_URL")
        val port = if (u.port > 0) u.port else u.defaultPort
        return withProxy(ctx, core, config) { p ->
            val t0 = SystemClock.elapsedRealtime()
            Socks.connect(p, host, port, timeoutMs).use { raw ->
                val sock: Socket = if (u.protocol == "https") Socks.tls(raw, host, port) else raw
                sock.soTimeout = timeoutMs
                val path = (u.path.ifEmpty { "/" }) + (u.query?.let { "?$it" } ?: "")
                val req = "GET $path HTTP/1.1\r\nHost: $host\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n"
                sock.getOutputStream().apply { write(req.toByteArray(Charsets.US_ASCII)); flush() }
                val status = readHead(sock.getInputStream())
                if (status in 200..399) maxOf(1L, SystemClock.elapsedRealtime() - t0) else -1L
            }
        }
    }

    /** Download for up to `seconds`; decimal MB/s, or -1 when nothing came through. */
    fun speed(ctx: Context, core: String, config: String, url: String, seconds: Int, cancelled: () -> Boolean): Double {
        val u = URL(url)
        require(u.protocol == "https" || u.protocol == "http") { "BAD_URL" }
        val host = u.host ?: throw IllegalArgumentException("BAD_URL")
        val port = if (u.port > 0) u.port else u.defaultPort
        return withProxy(ctx, core, config) { p ->
            Socks.connect(p, host, port, 10_000).use { raw ->
                val sock: Socket = if (u.protocol == "https") Socks.tls(raw, host, port) else raw
                sock.soTimeout = 10_000
                val path = (u.path.ifEmpty { "/" }) + (u.query?.let { "?$it" } ?: "")
                val req = "GET $path HTTP/1.1\r\nHost: $host\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
                sock.getOutputStream().apply { write(req.toByteArray(Charsets.US_ASCII)); flush() }
                val input = sock.getInputStream()
                val status = readHead(input)
                if (status !in 200..299) return@withProxy -1.0
                val buf = ByteArray(64 * 1024)
                val limit = seconds.coerceIn(3, 30) * 1000L
                var bytes = 0L
                val t0 = SystemClock.elapsedRealtime()
                var first = 0L
                try {
                    while (!cancelled()) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (first == 0L) first = SystemClock.elapsedRealtime()
                        bytes += n
                        if (SystemClock.elapsedRealtime() - t0 >= limit) break
                    }
                } catch (_: SocketTimeoutException) {
                    // what arrived until the stall still counts
                }
                val ms = SystemClock.elapsedRealtime() - (if (first > 0) first else t0)
                if (bytes <= 0 || ms <= 0) -1.0 else Math.round(bytes / (ms / 1000.0) / 1e6 * 100) / 100.0
            }
        }
    }

    /** One NTP question to `host:port` over UDP through the config; ms until the answer, or -1. */
    fun udp(ctx: Context, core: String, config: String, host: String, port: Int, timeoutMs: Int): Long = withProxy(ctx, core, config) { p ->
        val control = Socket()
        control.use { c ->
            c.connect(InetSocketAddress(LOOPBACK, p.port), 3000)
            c.soTimeout = timeoutMs
            val out = c.getOutputStream()
            val input = c.getInputStream()
            Socks.authenticate(out, input, p)
            // UDP ASSOCIATE; the relay address comes back in the reply.
            out.write(byteArrayOf(5, 3, 0, 1, 0, 0, 0, 0, 0, 0)); out.flush()
            val (relayHost, relayPort) = Socks.readReply(input)
            val relay = if (relayHost == null || relayHost.isAnyLocalAddress) LOOPBACK else relayHost
            val name = host.toByteArray(Charsets.US_ASCII)
            val ntp = ByteArray(48).also { it[0] = 0x1b } // NTP v3 client request
            val packet = byteArrayOf(0, 0, 0, 3, name.size.toByte()) + name + byteArrayOf((port shr 8).toByte(), port.toByte()) + ntp
            DatagramSocket().use { udp ->
                udp.soTimeout = 1500
                val t0 = SystemClock.elapsedRealtime()
                val answer = DatagramPacket(ByteArray(1024), 1024)
                while (SystemClock.elapsedRealtime() - t0 < timeoutMs) {
                    udp.send(DatagramPacket(packet, packet.size, relay, relayPort))
                    try {
                        udp.receive(answer)
                        if (answer.length > 10) return@withProxy SystemClock.elapsedRealtime() - t0
                    } catch (_: SocketTimeoutException) {
                        // UDP may drop a packet: ask again
                    }
                }
                -1L
            }
        }
    }

    // ---------------------------------------------------------------- core

    private val LOOPBACK = Local.LOOPBACK

    private fun <T> withProxy(ctx: Context, core: String, config: String, work: (Socks.Endpoint) -> T): T {
        if (core != "singbox") return withCore(config, work)
        val sb = SingBox.start(ctx, config, "probe-${seq.incrementAndGet()}")
        try {
            return work(Socks.Endpoint(sb.port, sb.user, sb.pass))
        } finally {
            sb.stop()
        }
    }

    private object Quiet : CoreCallbackHandler {
        override fun onEmitStatus(p0: Long, p1: String?): Long = 0
        override fun shutdown(): Long = 0
        override fun startup(): Long = 0
    }

    private fun <T> withCore(config: String, work: (Socks.Endpoint) -> T): T {
        val p = Socks.Endpoint(Local.freePort(), Local.token(), Local.token())
        val json = JSONObject(config)
        val inbound = JSONObject()
            .put("tag", "probe-in")
            .put("listen", "127.0.0.1")
            .put("port", p.port)
            .put("protocol", "socks")
            .put("settings", JSONObject()
                .put("auth", "password")
                .put("accounts", JSONArray().put(JSONObject().put("user", p.user).put("pass", p.pass)))
                .put("udp", true)
                .put("ip", "127.0.0.1"))
        // The config's own inbounds (the local forwarder of an unencrypted server) stay; the probe
        // inbound has no routing rule, so its traffic takes the first outbound.
        val inbounds = json.optJSONArray("inbounds") ?: JSONArray()
        inbounds.put(inbound)
        json.put("inbounds", inbounds)
        val core = Libv2ray.newCoreController(Quiet)
        synchronized(CoreLock) { core.startLoop(json.toString(), 0) }
        try {
            Local.waitReady(p.port, 3000)
            return work(p)
        } finally {
            try { core.stopLoop() } catch (_: Exception) { }
        }
    }

    // ---------------------------------------------------------------- HTTP

    /** Reads the status line and headers; returns the status code. */
    private fun readHead(input: InputStream): Int {
        val line = StringBuilder()
        var status = -1
        var total = 0
        while (true) {
            val c = input.read()
            if (c < 0) return -1
            if (++total > 32 * 1024) return -1
            if (c == '\n'.code) {
                val l = line.toString().trimEnd('\r')
                if (status < 0) status = Regex("^HTTP/\\d(?:\\.\\d)? (\\d{3})").find(l)?.groupValues?.get(1)?.toInt() ?: return -1
                else if (l.isEmpty()) return status
                line.setLength(0)
            } else {
                line.append(c.toChar())
            }
        }
    }
}
