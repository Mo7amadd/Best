package com.best.client.net

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.URL

/**
 * Downloads subscription contents (and other small texts: release feeds, checksum files).
 * Limits: http(s) only, public addresses only (a link can't make Best talk to this phone or the
 * local network), at most 5 redirects and never from https down to http, 8 MB, 25 s per step.
 * While connected the request goes through the connection (see Http).
 */
object Fetcher {

    /** `device`: what a panel that limits devices said ("limit", "required" or ""), see DeviceId. */
    data class Result(val status: Int, val body: String, val userInfo: String?, val title: String?, val updateHours: String?, val device: String = "")

    private const val MAX_BYTES = 8 * 1024 * 1024
    private const val TIMEOUT_MS = 25_000
    private const val MAX_REDIRECTS = 5

    /**
     * `direct`: never through the connection (the user's "subscriptions through the proxy" is off).
     * `extra`: more request headers (the device id of DeviceId).
     */
    fun get(url: String, userAgent: String, direct: Boolean = false, extra: Map<String, String> = emptyMap()): Result {
        var current = parse(url)
        var redirects = 0
        while (true) {
            val address = checkPublic(current, direct)
            val res = Http.request("GET", current, mapOf("User-Agent" to userAgent.take(200), "Accept" to "*/*") + extra, timeoutMs = TIMEOUT_MS, connectTo = address, tunnel = !direct)
            res.use {
                val code = it.status
                if (code in 300..399) {
                    val loc = it.header("location") ?: throw FetchException("BAD_REDIRECT")
                    val next = parse(URL(current, loc).toString())
                    if (current.protocol == "https" && next.protocol != "https") throw FetchException("HTTPS_DOWNGRADE")
                    if (++redirects > MAX_REDIRECTS) throw FetchException("TOO_MANY_REDIRECTS")
                    current = next
                    return@use
                }
                // A panel that limits devices says why it refused (Remnawave: 404 without an id).
                val device = DeviceId.status { n -> it.header(n) }
                if (code !in 200..299) throw FetchException(if (device == "limit") "HWID_LIMIT" else if (device == "required") "HWID_REQUIRED" else "HTTP_$code")
                if (it.length > MAX_BYTES) throw FetchException("TOO_LARGE")
                return Result(
                    status = code,
                    body = readLimited(it),
                    userInfo = it.header("subscription-userinfo"),
                    title = it.header("profile-title"),
                    updateHours = it.header("profile-update-interval"),
                    device = device,
                )
            }
        }
    }

    private fun parse(url: String): URL {
        val u = try { URL(url.trim()) } catch (_: Exception) { throw FetchException("BAD_URL") }
        if (u.protocol != "https" && u.protocol != "http") throw FetchException("BAD_URL")
        if (u.host.isNullOrBlank() || u.userInfo != null) throw FetchException("BAD_URL")
        return u
    }

    /**
     * Refuses loopback, private, link-local and other non-public destinations; returns the checked
     * address a direct connection must use (so a second lookup can't point somewhere else). While
     * connected the name is resolved by the server, so only addresses written in the link (and
     * "localhost") are checked here.
     */
    private fun checkPublic(u: URL, direct: Boolean): InetAddress? {
        val host = u.host.removePrefix("[").removeSuffix("]")
        if (host.equals("localhost", ignoreCase = true) || host.endsWith(".localhost", ignoreCase = true)) throw FetchException("LOCAL_ADDRESS")
        // Development build only: the emulator's way to the computer, for test panels running there.
        if (com.best.client.BuildConfig.DEBUG && host == "10.0.2.2" && (!Http.tunneled || direct)) return InetAddress.getByName(host)
        val literal = Regex("^[0-9.]+$|:").containsMatchIn(host)
        if (Http.tunneled && !direct && !literal) return null
        val addrs = try { InetAddress.getAllByName(host) } catch (_: Exception) { throw FetchException("DNS_FAILED") }
        for (a in addrs) if (!isPublic(a)) throw FetchException("LOCAL_ADDRESS")
        return addrs.firstOrNull()
    }

    fun isPublic(a: InetAddress): Boolean {
        if (a.isAnyLocalAddress || a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isMulticastAddress) return false
        val b = a.address
        // Unique-local IPv6 (fc00::/7) and carrier-grade NAT (100.64.0.0/10).
        if (b.size == 16 && (b[0].toInt() and 0xFE) == 0xFC) return false
        if (b.size == 4 && (b[0].toInt() and 0xFF) == 100 && (b[1].toInt() and 0xC0) == 64) return false
        return true
    }

    private fun readLimited(res: Http.Response): String {
        val out = ByteArrayOutputStream()
        res.body.use { input ->
            val buf = ByteArray(16 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                if (out.size() + n > MAX_BYTES) throw FetchException("TOO_LARGE")
                out.write(buf, 0, n)
            }
        }
        return out.toString("UTF-8")
    }

    class FetchException(code: String) : Exception(code)
}
