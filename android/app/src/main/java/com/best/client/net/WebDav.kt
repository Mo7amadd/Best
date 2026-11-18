package com.best.client.net

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * Backups on the user's own WebDAV server (Nextcloud, a NAS…), the same way as Best for Windows:
 * only already-encrypted backups are uploaded (the password never leaves the phone), https is
 * required except for a server in the local network, and only best-backup-*.best files are read.
 * A server in the local network is reached directly; any other one through the connection while
 * connected (see Http).
 */
class WebDav(url: String, private val user: String, private val pass: String, dir: String) {

    private val base: URL
    private val root: String
    private val local: Boolean

    init {
        val u = try { URL(url.trim()) } catch (_: Exception) { throw IllegalArgumentException("WEBDAV_URL") }
        if (u.userInfo != null || u.host.isNullOrBlank()) throw IllegalArgumentException("WEBDAV_URL")
        local = isPrivateHost(u.host)
        if (!(u.protocol == "https" || (u.protocol == "http" && local))) throw IllegalArgumentException("WEBDAV_URL")
        base = u
        val folder = dir.trim().ifEmpty { "Best" }.take(64)
        root = u.toString().trimEnd('/') + "/" + URLEncoder.encode(folder, "UTF-8").replace("+", "%20") + "/"
    }

    private fun req(method: String, target: String, body: ByteArray? = null, headers: Map<String, String> = emptyMap(), ok: Set<Int> = OK): Http.Response {
        val h = HashMap(headers)
        h["User-Agent"] = "Best"
        if (user.isNotEmpty()) h["Authorization"] = "Basic " + android.util.Base64.encodeToString("$user:$pass".toByteArray(), android.util.Base64.NO_WRAP)
        val u = URL(target)
        val res = Http.request(method, u, h, body, timeoutMs = 60_000, connectTo = if (local) InetAddress.getByName(u.host) else null, tunnel = !local)
        if (res.status == 401 || res.status == 403) { res.close(); throw IllegalStateException("WEBDAV_AUTH") }
        if (res.status !in ok) { res.close(); throw IllegalStateException("HTTP_${res.status}") }
        return res
    }

    private fun text(res: Http.Response, max: Int): String = res.use {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = it.body.read(buf)
            if (n < 0) break
            if (out.size() + n > max) throw IllegalStateException("TOO_LARGE")
            out.write(buf, 0, n)
        }
        out.toString("UTF-8")
    }

    fun put(name: String, data: String) {
        require(NAME.matches(name)) { "BAD_ARGUMENTS" }
        req("MKCOL", root, ok = setOf(200, 201, 204, 405)).close() // 405: already there
        req("PUT", root + URLEncoder.encode(name, "UTF-8"), data.toByteArray(Charsets.UTF_8), mapOf("Content-Type" to "application/octet-stream")).close()
    }

    /** Backups in the folder, newest first: name → last modified (ms). */
    fun list(): List<Pair<String, Long>> {
        val body = "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:getlastmodified/></d:prop></d:propfind>"
        val res = req("PROPFIND", root, body.toByteArray(), mapOf("Depth" to "1", "Content-Type" to "application/xml"), ok = setOf(207, 404))
        if (res.status == 404) { res.close(); return emptyList() }
        val xml = text(res, 2 * 1024 * 1024)
        val out = ArrayList<Pair<String, Long>>()
        for (block in xml.split(Regex("<(?:[a-zA-Z]+:)?response[\\s>]", RegexOption.IGNORE_CASE)).drop(1)) {
            val href = Regex("<(?:[a-zA-Z]+:)?href>([^<]+)<", RegexOption.IGNORE_CASE).find(block)?.groupValues?.get(1) ?: continue
            val name = try { URLDecoder.decode(href.trimEnd('/').substringAfterLast('/'), "UTF-8") } catch (_: Exception) { continue }
            if (!NAME.matches(name)) continue
            val mod = Regex("<(?:[a-zA-Z]+:)?getlastmodified>([^<]+)<", RegexOption.IGNORE_CASE).find(block)?.groupValues?.get(1)
            val ms = try { java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US).parse(mod ?: "")?.time ?: 0L } catch (_: Exception) { 0L }
            out += name to ms
        }
        return out.sortedWith(compareByDescending<Pair<String, Long>> { it.second }.thenByDescending { it.first }).take(50)
    }

    fun get(name: String): String {
        require(NAME.matches(name)) { "BAD_ARGUMENTS" }
        val res = req("GET", root + URLEncoder.encode(name, "UTF-8"))
        if (res.length > MAX) { res.close(); throw IllegalStateException("TOO_LARGE") }
        return text(res, MAX)
    }

    companion object {
        private val OK = setOf(200, 201, 204, 207)
        private const val MAX = 50 * 1024 * 1024
        val NAME = Regex("^best-backup-[\\w.-]{1,80}\\.best$")

        /** A server inside the local network: a private / loopback address, "localhost" or a single-label .local name. */
        fun isPrivateHost(hostname: String): Boolean {
            val h = hostname.lowercase().removePrefix("[").removeSuffix("]")
            if (h == "localhost" || Regex("^[a-z0-9-]{1,63}\\.local$").matches(h)) return true
            val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}$").matchEntire(h)
            if (v4 != null) {
                val a = v4.groupValues[1].toInt(); val b = v4.groupValues[2].toInt()
                return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b in 16..31) || (a == 169 && b == 254)
            }
            if (h.contains(':')) return h == "::1" || Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(h) || Regex("^fe[89ab][0-9a-f]:").containsMatchIn(h)
            return false
        }
    }
}
