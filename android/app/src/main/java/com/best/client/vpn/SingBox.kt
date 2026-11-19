package com.best.client.vpn

import android.content.Context
import android.util.Log
import com.best.client.BuildConfig
import com.best.client.net.Local
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * sing-box, for configs Xray can't open. The official sing-box program for Android is packed as
 * lib/<abi>/libsingbox.so (Android only lets apps run programs from their library folder) and
 * started with a config holding just that server and one SOCKS inbound on 127.0.0.1, protected by
 * a random user name and password. It runs as Best itself, so like Best it is outside the VPN.
 * The config file is private to Best and removed as soon as sing-box has read it.
 */
object SingBox {

    private const val TAG = "BestSingBox"
    private const val START_TIMEOUT_MS = 8000L

    class Running internal constructor(val process: Process, val port: Int, val user: String, val pass: String) {
        @Volatile var stopping = false

        val alive: Boolean get() = isAlive(process)

        fun stop() {
            stopping = true
            process.destroy()
            val until = android.os.SystemClock.elapsedRealtime() + 2000
            while (isAlive(process) && android.os.SystemClock.elapsedRealtime() < until) {
                try { Thread.sleep(50) } catch (_: InterruptedException) { break }
            }
            if (isAlive(process) && android.os.Build.VERSION.SDK_INT >= 26) process.destroyForcibly()
        }
    }

    /** Process.isAlive needs Android 8; this works on 7 too. */
    fun isAlive(p: Process): Boolean = try {
        p.exitValue()
        false
    } catch (_: IllegalThreadStateException) {
        true
    }

    private fun binary(ctx: Context) = File(ctx.applicationInfo.nativeLibraryDir, "libsingbox.so")

    fun available(ctx: Context) = binary(ctx).isFile

    fun version(ctx: Context): String = try {
        val p = ProcessBuilder(binary(ctx).path, "version").redirectErrorStream(true).start()
        val text = p.inputStream.bufferedReader().use { it.readText() }
        p.waitFor()
        Regex("version ([0-9][0-9A-Za-z.+-]*)").find(text)?.groupValues?.get(1).orEmpty()
    } catch (_: Exception) {
        ""
    }

    /** Starts sing-box with `config` (no inbounds) plus the SOCKS inbound; returns once it listens. */
    fun start(ctx: Context, config: String, name: String): Running {
        if (!available(ctx)) throw IllegalStateException("NEEDS_SINGBOX")
        val json = JSONObject(config)
        val port = Local.freePort()
        val user = Local.token()
        val pass = Local.token()
        json.put("inbounds", JSONArray().put(JSONObject()
            .put("type", "socks")
            .put("tag", "best-in")
            .put("listen", "127.0.0.1")
            .put("listen_port", port)
            .put("users", JSONArray().put(JSONObject().put("username", user).put("password", pass)))))
        // Nothing that opens other listeners or writes files elsewhere.
        json.remove("experimental")
        val dir = File(ctx.noBackupFilesDir, "singbox").apply { mkdirs() }
        val file = File(dir, "$name.json")
        file.writeText(json.toString())
        file.setReadable(false, false)
        file.setReadable(true, true)
        val process = try {
            ProcessBuilder(binary(ctx).path, "run", "-c", file.path, "-D", dir.path, "--disable-color")
                .directory(dir)
                .redirectErrorStream(true)
                // Naive configs load Chromium's network library (libcronet.so) from next to sing-box.
                .apply {
                    environment()["LD_LIBRARY_PATH"] = ctx.applicationInfo.nativeLibraryDir
                    // Up-to-date root certificates (see BestApp.caBundle).
                    val ca = File(ctx.filesDir, "xray/${com.best.client.BestApp.CA_FILE}")
                    if (ca.isFile) environment()["SSL_CERT_FILE"] = ca.absolutePath
                }
                .start()
        } catch (e: Exception) {
            file.delete()
            throw IllegalStateException("SINGBOX_START")
        }
        drain(process, if (name.startsWith("probe")) null else ctx.applicationContext)
        val running = Running(process, port, user, pass)
        try {
            Local.waitReady(port, START_TIMEOUT_MS) { isAlive(process) }
        } catch (e: Exception) {
            running.stop()
            throw IllegalStateException("SINGBOX_START")
        } finally {
            file.delete()
        }
        return running
    }

    /**
     * Reads sing-box's output so it never blocks on a full pipe. The connection's sing-box (not the
     * short ones of the tests) goes to the Logs page; its level is in the line ("ERROR [..] …").
     */
    private fun drain(p: Process, logTo: Context?) {
        Thread({
            try {
                p.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { line ->
                        if (BuildConfig.DEBUG) Log.d(TAG, line.take(300))
                        if (logTo != null) {
                            val m = Regex("^(?:\\S+ \\S+ \\S+ )?(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)\\b\\s*(.*)$").find(line)
                            val level = when (m?.groupValues?.get(1)) { "TRACE", "DEBUG" -> "debug"; "INFO" -> "info"; "WARN" -> "warning"; null -> "info"; else -> "error" }
                            Logs.add(logTo, level, "sing-box", m?.groupValues?.get(2) ?: line)
                        }
                    }
                }
            } catch (_: Exception) { }
        }, "best-singbox-log").apply { isDaemon = true }.start()
    }

    /** Points Xray's "proxy" SOCKS outbound (built with a placeholder) at the running sing-box. */
    fun linkXray(xrayConfig: String, sb: Running): String {
        val json = JSONObject(xrayConfig)
        val outs = json.getJSONArray("outbounds")
        for (i in 0 until outs.length()) {
            val o = outs.getJSONObject(i)
            if (o.optString("tag") != "proxy" || o.optString("protocol") != "socks") continue
            val server = o.getJSONObject("settings").getJSONArray("servers").getJSONObject(0)
            if (server.optString("address") != "127.0.0.1") break
            server.put("port", sb.port)
            server.put("users", JSONArray().put(JSONObject().put("user", sb.user).put("pass", sb.pass)))
            return json.toString()
        }
        throw IllegalStateException("CORE_CONFIG")
    }
}
