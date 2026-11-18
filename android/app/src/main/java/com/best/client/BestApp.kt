package com.best.client

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.util.Base64
import java.io.File
import java.security.SecureRandom
import libv2ray.Libv2ray

class BestApp : Application() {

    override fun onCreate() {
        super.onCreate()
        initCore()
        createChannels()
        // The home-screen widget follows the connection.
        com.best.client.vpn.VpnState.onState { com.best.client.vpn.BestWidget.refresh(this) }
        shortcuts()
    }

    /** Launcher shortcuts (long-press Best's icon): connect / disconnect, scan a QR code. */
    private fun shortcuts() {
        try {
            val toggle = androidx.core.content.pm.ShortcutInfoCompat.Builder(this, "toggle")
                .setShortLabel(getString(R.string.shortcut_toggle))
                .setIcon(androidx.core.graphics.drawable.IconCompat.createWithResource(this, R.mipmap.ic_launcher))
                .setIntent(android.content.Intent(this, com.best.client.vpn.ShortcutActivity::class.java).setAction(android.content.Intent.ACTION_VIEW))
                .build()
            val scan = androidx.core.content.pm.ShortcutInfoCompat.Builder(this, "scan")
                .setShortLabel(getString(R.string.shortcut_scan))
                .setIcon(androidx.core.graphics.drawable.IconCompat.createWithResource(this, R.mipmap.ic_launcher))
                .setIntent(android.content.Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_SCAN))
                .build()
            androidx.core.content.pm.ShortcutManagerCompat.setDynamicShortcuts(this, listOf(toggle, scan))
        } catch (_: Exception) { }
    }

    /**
     * Xray environment: its data folder (routing data updates land here; until then the files
     * packed in the library are used) and the per-install XUDP key.
     */
    private fun initCore() {
        val dir = File(filesDir, "xray").apply { mkdirs() }
        caBundle(dir)
        Libv2ray.initCoreEnv(dir.absolutePath, xudpKey())
    }

    /**
     * Up-to-date root certificates for Xray and sing-box (Go reads SSL_CERT_FILE in addition to
     * Android's store). Old Android versions lack newer roots, so DNS over HTTPS and other TLS
     * connections made by the cores failed there. Must be set before the Xray library loads: the
     * Go runtime copies the environment when it starts.
     */
    private fun caBundle(dir: File) {
        val f = File(dir, CA_FILE)
        val marker = File(dir, ".cacert")
        val stamp = BuildConfig.VERSION_CODE.toString()
        try {
            if (!(f.isFile && marker.isFile && marker.readText() == stamp)) {
                val tmp = File(dir, "$CA_FILE.part")
                assets.open(CA_FILE).use { input -> tmp.outputStream().use { input.copyTo(it) } }
                if (!tmp.renameTo(f)) tmp.delete()
                marker.writeText(stamp)
            }
            if (f.isFile) android.system.Os.setenv("SSL_CERT_FILE", f.absolutePath, true)
        } catch (_: Exception) {
            // Without it the cores use Android's own store, as before.
        }
    }

    /**
     * 32 random bytes made once per install, kept out of every backup. Xray reads the key as
     * URL-safe base64 without padding (43 characters).
     */
    private fun xudpKey(): String {
        val f = File(noBackupFilesDir, "xudp.key")
        val old = if (f.isFile) f.readText().trim() else ""
        if (XUDP_KEY.matches(old)) return old
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val key = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        f.writeText(key)
        return key
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL_VPN, getString(R.string.channel_vpn), NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(ch)
    }

    companion object {
        const val CHANNEL_VPN = "vpn"
        const val CA_FILE = "cacert.pem"
        private val XUDP_KEY = Regex("^[A-Za-z0-9_-]{43}$")
    }
}
