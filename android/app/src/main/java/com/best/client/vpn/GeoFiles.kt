package com.best.client.vpn

import android.content.Context
import com.best.client.BuildConfig
import java.io.File

/**
 * Xray reads its routing data (geoip.dat / geosite.dat) from its data folder. The copies packed in
 * the Xray library are placed there on first use and again after each app update; a routing data
 * update replaces them in the same folder until the next app update. Each file is written beside
 * the target and then renamed, so a half-written file is never used.
 */
object GeoFiles {

    val FILES = listOf("geoip.dat", "geosite.dat")

    /** Optional richer country lists (Iran, Russia), installed from Updates; never packed. */
    val EXT_FILES = mapOf("ir" to listOf("geosite_IR.dat", "geoip_IR.dat"), "ru" to listOf("geosite_RU.dat", "geoip_RU.dat"))
    val ALL_FILES = FILES + EXT_FILES.values.flatten()
    private const val DOWNLOADED = " dl"

    fun dir(context: Context) = File(context.filesDir, "xray").apply { mkdirs() }

    private fun stamp() = "${BuildConfig.VERSION_CODE}/${BuildConfig.XRAY_LIB}"

    @Synchronized
    fun ensure(context: Context) {
        val dir = dir(context)
        val marker = File(dir, ".packed")
        val text = if (marker.isFile) marker.readText() else ""
        val upToDate = (text == stamp() || text == stamp() + DOWNLOADED) && FILES.all { File(dir, it).length() > 0 }
        if (upToDate) return
        for (name in FILES) {
            val target = File(dir, name)
            val tmp = File(dir, "$name.part")
            context.assets.open(name).use { input -> tmp.outputStream().use { input.copyTo(it) } }
            if (!tmp.renameTo(target)) {
                tmp.delete()
                throw IllegalStateException("GEO_COPY_FAILED")
            }
        }
        marker.writeText(stamp())
    }

    /** Puts downloaded (already verified) files in place: name → file in the same folder. */
    @Synchronized
    fun install(context: Context, files: Map<String, File>) {
        val dir = dir(context)
        for ((name, file) in files) {
            require(name in ALL_FILES && file.parentFile == dir) { "BAD_ARGUMENTS" }
            if (!file.renameTo(File(dir, name))) throw IllegalStateException("FAILED")
        }
        if (files.keys.any { it in FILES }) File(dir, ".packed").writeText(stamp() + DOWNLOADED)
    }

    /** Which optional country lists are installed: {"ir": time or 0, "ru": …}. */
    fun extInfo(context: Context): org.json.JSONObject {
        val dir = dir(context)
        val out = org.json.JSONObject()
        for ((cc, names) in EXT_FILES) {
            val fs = names.map { File(dir, it) }
            out.put(cc, if (fs.all { it.length() > 0 }) fs.minOf { it.lastModified() } else 0L)
        }
        return out
    }

    /** Where the routing data in use came from, and when it was written. */
    fun info(context: Context): Pair<Boolean, Long> {
        val dir = dir(context)
        val marker = File(dir, ".packed")
        val downloaded = marker.isFile && marker.readText().endsWith(DOWNLOADED)
        return downloaded to File(dir, "geosite.dat").lastModified()
    }
}
