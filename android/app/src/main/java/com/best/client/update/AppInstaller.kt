package com.best.client.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.best.client.BuildConfig
import java.io.File
import java.security.MessageDigest

/**
 * Installs a downloaded update of Best with Android's own installer (the user confirms it). Before
 * that the APK must be Best (same package name), newer than this version, and signed with the
 * same key; Android checks the key again itself and never replaces an app with a differently
 * signed one.
 */
object AppInstaller {

    /** Told when an install fails or is cancelled (the page shows it). */
    @Volatile var listener: ((String) -> Unit)? = null

    fun check(context: Context, apk: File) {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info = pm.getPackageArchiveInfo(apk.path, flags) ?: throw IllegalStateException("UPDATE_BAD_APK")
        if (info.packageName != context.packageName) throw IllegalStateException("UPDATE_BAD_APK")
        if (versionCode(info) <= BuildConfig.VERSION_CODE) throw IllegalStateException("UPDATE_NOT_NEWER")
        val mine = pm.getPackageInfo(context.packageName, flags)
        val now = signers(mine)
        val next = signers(info)
        val history = history(info)
        // Same key, or a newer key that lists the current one in its rotation history.
        if (now.isNotEmpty() && next.isNotEmpty() && next != now && !history.containsAll(now)) throw IllegalStateException("UPDATE_BAD_SIGNATURE")
    }

    /** Needs "install unknown apps" for Best; false when the user still has to allow it. */
    fun canInstall(context: Context) = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 26) setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 64 * 1024) }
                    session.fsync(out)
                }
                val intent = Intent(context, InstallReceiver::class.java).setPackage(context.packageName)
                val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutable)
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            try { installer.abandonSession(id) } catch (_: Exception) { }
            throw e
        }
    }

    @Suppress("DEPRECATION")
    private fun versionCode(p: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signers(p: PackageInfo): Set<String> {
        val certs = if (Build.VERSION.SDK_INT >= 28) p.signingInfo?.apkContentsSigners else p.signatures
        return certs.orEmpty().map { sha(it.toByteArray()) }.toSet()
    }

    private fun history(p: PackageInfo): Set<String> {
        if (Build.VERSION.SDK_INT < 28) return emptySet()
        val s = p.signingInfo ?: return emptySet()
        if (s.hasMultipleSigners()) return emptySet()
        return s.signingCertificateHistory.orEmpty().map { sha(it.toByteArray()) }.toSet()
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
}

/**
 * Status of an install session. Not exported: only Android's installer, through the
 * PendingIntent Best created, can reach it.
 */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirm == null) {
                    AppInstaller.listener?.invoke("UPDATE_INSTALL_FAILED")
                    return
                }
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    if (BuildConfig.DEBUG) Log.w("BestUpdate", "confirm", e)
                    AppInstaller.listener?.invoke("UPDATE_INSTALL_FAILED")
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // Best is replaced and restarted by Android
            PackageInstaller.STATUS_FAILURE_ABORTED -> AppInstaller.listener?.invoke("UPDATE_CANCELLED")
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> AppInstaller.listener?.invoke("UPDATE_BAD_SIGNATURE")
            PackageInstaller.STATUS_FAILURE_STORAGE -> AppInstaller.listener?.invoke("UPDATE_NO_SPACE")
            else -> {
                if (BuildConfig.DEBUG) Log.w("BestUpdate", "status $status")
                AppInstaller.listener?.invoke("UPDATE_INSTALL_FAILED")
            }
        }
    }
}
