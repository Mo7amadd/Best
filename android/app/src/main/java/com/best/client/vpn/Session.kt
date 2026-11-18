package com.best.client.vpn

import android.content.Context
import android.util.AtomicFile
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the VPN runs: the Xray config (built by the shared core in the UI), which apps go through
 * it, and the notification texts in the UI's language. Saved privately (never backed up) so
 * "Always-on VPN" can start the same connection again after a reboot.
 */
data class Session(
    val config: String,
    /** sing-box config for servers Xray can't open (Xray then hands their traffic to it), or null. */
    val singbox: String?,
    val name: String,
    /** "all": every app; "include": only [apps]; "exclude": every app except [apps]. */
    val appMode: String,
    val apps: List<String>,
    val ipv6: Boolean,
    /** Also log connections (the sites visited) to Best's private folder; off unless the user turns it on. */
    val logAccess: Boolean,
    /** "vpn": every app through the VPN interface; "proxy": only local SOCKS / HTTP ports, no VPN. */
    val mode: String,
    /** Size of packets on the VPN interface. */
    val mtu: Int,
    val textConnected: String,
    val textConnecting: String,
    val textDisconnect: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("config", config)
        .put("singbox", singbox ?: JSONObject.NULL)
        .put("name", name)
        .put("appMode", appMode)
        .put("apps", JSONArray(apps))
        .put("ipv6", ipv6)
        .put("logAccess", logAccess)
        .put("mode", mode)
        .put("mtu", mtu)
        .put("text", JSONObject().put("connected", textConnected).put("connecting", textConnecting).put("disconnect", textDisconnect))

    companion object {
        private const val MAX_CONFIG = 2 * 1024 * 1024
        private val MODES = setOf("all", "include", "exclude")
        private val PKG = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")

        /** Validates everything coming from the UI; throws IllegalArgumentException on bad input. */
        fun fromJson(o: JSONObject): Session {
            val config = o.getString("config")
            require(config.length in 2..MAX_CONFIG) { "BAD_CONFIG" }
            JSONObject(config) // must be a JSON object
            val singbox = if (o.isNull("singbox")) null else o.optString("singbox").takeIf { it.isNotEmpty() }
            if (singbox != null) {
                require(singbox.length <= MAX_CONFIG) { "BAD_CONFIG" }
                JSONObject(singbox)
            }
            val mode = o.optString("appMode", "all").takeIf { it in MODES } ?: "all"
            val arr = o.optJSONArray("apps") ?: JSONArray()
            val apps = (0 until minOf(arr.length(), 500)).map { arr.optString(it) }.filter { it.length <= 255 && PKG.matches(it) }.distinct()
            val t = o.optJSONObject("text") ?: JSONObject()
            fun text(k: String, d: String) = t.optString(k, d).take(80).ifBlank { d }
            return Session(
                config = config,
                singbox = singbox,
                name = o.optString("name").take(120),
                appMode = mode,
                apps = apps,
                ipv6 = o.optBoolean("ipv6", false),
                logAccess = o.optBoolean("logAccess", false),
                mode = if (o.optString("mode") == "proxy") "proxy" else "vpn",
                mtu = o.optInt("mtu", 1500).coerceIn(1280, 9000),
                textConnected = text("connected", "Connected"),
                textConnecting = text("connecting", "Connecting…"),
                textDisconnect = text("disconnect", "Disconnect"),
            )
        }

        private fun file(ctx: Context) = AtomicFile(File(ctx.noBackupFilesDir, "session.json"))

        fun save(ctx: Context, s: Session) {
            val f = file(ctx)
            val out = f.startWrite()
            try {
                out.write(s.toJson().toString().toByteArray(Charsets.UTF_8))
                f.finishWrite(out)
            } catch (e: Exception) {
                f.failWrite(out)
                throw e
            }
        }

        fun load(ctx: Context): Session? = try {
            fromJson(JSONObject(String(file(ctx).readFully(), Charsets.UTF_8)))
        } catch (_: Exception) {
            null
        }
    }
}
