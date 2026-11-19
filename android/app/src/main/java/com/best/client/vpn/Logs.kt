package com.best.client.vpn

import android.content.Context
import java.io.File
import java.io.RandomAccessFile

/**
 * Logs in Best's private folder, shown on the Logs page:
 *  - error.log: Xray's own log (its level is Settings › Advanced › Log level);
 *  - app.log: what Best itself did (connect, disconnect, subscriptions, errors) and sing-box's lines,
 *    in Xray's format ("2026/11/19 12:00:00.000000 [Info] Best: …") so both read the same way;
 *  - access.log: connections, only when the user turns that on (they list the sites visited),
 *    emptied at each connection.
 * Kept small: cut when they grow past [MAX_SIZE]. Never leave the phone unless the user copies them.
 */
object Logs {

    const val MAX_SIZE = 2L * 1024 * 1024
    private const val READ_MAX = 128 * 1024

    fun dir(ctx: Context) = File(ctx.noBackupFilesDir, "logs").apply { mkdirs() }
    fun error(ctx: Context) = File(dir(ctx), "error.log")
    fun access(ctx: Context) = File(dir(ctx), "access.log")
    fun app(ctx: Context) = File(dir(ctx), "app.log")

    /** Everything, from the Logs page's "clear". */
    fun clear(ctx: Context) {
        for (f in listOf(error(ctx), access(ctx), app(ctx))) cut(f)
    }

    private val STAMP = java.text.SimpleDateFormat("yyyy/MM/dd HH:mm:ss.SSS'000'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
    private val LEVELS = mapOf("debug" to "Debug", "info" to "Info", "warning" to "Warning", "error" to "Error")

    /** One line of app.log: one line of printable text, never a password (callers pass names and codes). */
    fun add(ctx: Context, level: String, source: String, text: String) {
        val lv = LEVELS[level.lowercase()] ?: "Info"
        val clean = text.replace(Regex("[\\r\\n\\t]+"), " ").replace(Regex("\\p{Cntrl}"), "").trim().take(400)
        if (clean.isEmpty()) return
        val src = source.replace(Regex("[^\\w.-]"), "").take(16).ifEmpty { "Best" }
        synchronized(this) {
            try {
                val f = app(ctx)
                if (f.length() > MAX_SIZE / 4) cut(f)
                f.appendText("${STAMP.format(java.util.Date())} [$lv] $src: $clean\n", Charsets.UTF_8)
            } catch (_: Exception) { }
        }
    }

    /** Empties a log Xray may still be writing to (it appends, so it simply continues at 0). */
    fun cut(f: File) {
        if (!f.exists()) return
        try { RandomAccessFile(f, "rw").use { it.setLength(0) } } catch (_: Exception) { }
    }

    fun trim(ctx: Context) {
        for (f in listOf(error(ctx), access(ctx))) if (f.length() > MAX_SIZE) cut(f)
    }

    /** The end of a log (at most 128 KB), from a whole line on. */
    fun tail(f: File): String {
        if (!f.isFile) return ""
        RandomAccessFile(f, "r").use { r ->
            val len = r.length()
            val from = maxOf(0L, len - READ_MAX)
            r.seek(from)
            val b = ByteArray((len - from).toInt())
            r.readFully(b)
            val text = String(b, Charsets.UTF_8)
            return if (from > 0) text.substringAfter('\n') else text
        }
    }
}
