package com.best.client.update

import android.os.SystemClock
import java.io.File
import com.best.client.net.Http
import java.net.URL
import java.security.MessageDigest

/**
 * Downloads release files (Best's own APK, routing data) from GitHub only. The first address must
 * be a release download of one of the known repositories; redirects may only lead to GitHub's
 * download hosts, always over https. The file is written next to its target as ".part", hashed
 * while it arrives, and kept only when its SHA-256 is exactly the published one.
 */
object Downloader {

    private val START = Regex("^https://github\\.com/([A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100})/releases/download/[A-Za-z0-9._+-]{1,100}/[A-Za-z0-9._+-]{1,200}$")
    private val HOSTS = setOf("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")
    private const val MAX_REDIRECTS = 5
    private const val TIMEOUT_MS = 30_000

    fun interface Progress {
        fun update(done: Long, total: Long)
    }

    class Cancelled : Exception("CANCELLED")

    /**
     * Saves `url` as `target` when its SHA-256 is `sha256`. `repos`: repositories allowed for this
     * kind of file. Throws an exception whose message is an error code.
     */
    fun fetch(url: String, sha256: String, target: File, maxBytes: Long, repos: Set<String>, progress: Progress, cancelled: () -> Boolean) {
        val m = START.matchEntire(url) ?: throw IllegalArgumentException("BAD_URL")
        if (repos.none { it.equals(m.groupValues[1], ignoreCase = true) }) throw IllegalArgumentException("BAD_URL")
        require(Regex("^[0-9a-f]{64}$").matches(sha256)) { "BAD_ARGUMENTS" }
        target.parentFile?.mkdirs()
        val part = File(target.path + ".part")
        part.delete()
        var current = URL(url)
        var redirects = 0
        try {
            while (true) {
                if (current.protocol != "https" || current.host !in HOSTS || current.userInfo != null) throw IllegalStateException("BAD_REDIRECT")
                val conn = Http.request("GET", current, mapOf("User-Agent" to "Best-Android"), timeoutMs = TIMEOUT_MS)
                try {
                    val code = conn.status
                    if (code in 300..399) {
                        val loc = conn.header("location") ?: throw IllegalStateException("BAD_REDIRECT")
                        if (++redirects > MAX_REDIRECTS) throw IllegalStateException("TOO_MANY_REDIRECTS")
                        current = URL(current, loc)
                        continue
                    }
                    if (code !in 200..299) throw IllegalStateException("HTTP_$code")
                    val total = conn.length
                    if (total > maxBytes) throw IllegalStateException("TOO_LARGE")
                    val digest = MessageDigest.getInstance("SHA-256")
                    var done = 0L
                    var lastReport = 0L
                    conn.body.use { input ->
                        part.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                if (cancelled()) throw Cancelled()
                                val n = input.read(buf)
                                if (n < 0) break
                                done += n
                                if (done > maxBytes) throw IllegalStateException("TOO_LARGE")
                                digest.update(buf, 0, n)
                                out.write(buf, 0, n)
                                val now = SystemClock.elapsedRealtime()
                                if (now - lastReport > 250) {
                                    lastReport = now
                                    progress.update(done, total)
                                }
                            }
                            out.fd.sync()
                        }
                    }
                    progress.update(done, total)
                    val hex = digest.digest().joinToString("") { "%02x".format(it) }
                    if (hex != sha256) throw IllegalStateException("CHECKSUM_MISMATCH")
                    if (!part.renameTo(target)) throw IllegalStateException("FAILED")
                    return
                } finally {
                    conn.close()
                }
            }
        } catch (e: Exception) {
            part.delete()
            throw e
        }
    }

    /** SHA-256 of a file on disk (checked again right before it is used). */
    fun sha256(file: File): String {
        val d = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                d.update(buf, 0, n)
            }
        }
        return d.digest().joinToString("") { "%02x".format(it) }
    }
}
