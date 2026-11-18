package com.best.client.vpn

import android.content.Context
import java.io.File
import java.io.RandomAccessFile

/**
 * Xray's logs, written to Best's private folder: errors always, connections ("access") only when
 * the user turns that on (they list the sites visited). Kept small: cleared at each connection
 * and cut when they grow past [MAX_SIZE]. Never leave the phone unless the user copies them.
 */
object Logs {

    const val MAX_SIZE = 2L * 1024 * 1024
    private const val READ_MAX = 128 * 1024

    fun dir(ctx: Context) = File(ctx.noBackupFilesDir, "logs").apply { mkdirs() }
    fun error(ctx: Context) = File(dir(ctx), "error.log")
    fun access(ctx: Context) = File(dir(ctx), "access.log")

    fun clear(ctx: Context) {
        for (f in listOf(error(ctx), access(ctx))) cut(f)
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
