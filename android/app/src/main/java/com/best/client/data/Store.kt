package com.best.client.data

import android.content.Context
import android.util.AtomicFile
import java.io.File

/**
 * The app's own data (configs, subscriptions, settings…) as JSON text in private storage.
 * The UI validates the content with the shared core (sanitizeSettings / normalizeServer); this
 * class only allows a fixed set of names and sizes, and writes atomically (a crash mid-write
 * keeps the previous file).
 */
class Store(context: Context) {

    private val dir = File(context.filesDir, "data").apply { mkdirs() }

    fun read(name: String): String? {
        val f = file(name)
        if (!f.baseFile.exists()) return null
        val bytes = f.readFully()
        require(bytes.size <= MAX_BYTES) { "TOO_LARGE" }
        return String(bytes, Charsets.UTF_8)
    }

    fun write(name: String, text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BYTES) { "TOO_LARGE" }
        val f = file(name)
        val out = f.startWrite()
        try {
            out.write(bytes)
            f.finishWrite(out)
        } catch (e: Exception) {
            f.failWrite(out)
            throw e
        }
    }

    private fun file(name: String): AtomicFile {
        require(name in NAMES) { "BAD_NAME" }
        return AtomicFile(File(dir, "$name.json"))
    }

    companion object {
        val NAMES = setOf("settings", "routing", "servers", "subs", "ui")
        const val MAX_BYTES = 16 * 1024 * 1024
    }
}
