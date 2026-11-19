package com.best.client.vpn

import android.content.Context
import android.content.Intent
import android.net.VpnService
import com.best.client.MainActivity

/**
 * Connect / disconnect from outside the app's screen (Quick Settings tile, home-screen widget,
 * launcher shortcut, Tasker, start after boot), always with the last used connection. When
 * Android still has to allow the VPN, Best is opened instead (only an app on screen may ask).
 */
object VpnToggle {

    fun isOn() = VpnState.current.phase.let { it == VpnState.Phase.CONNECTED || it == VpnState.Phase.CONNECTING }

    /** A tap while it is still disconnecting does nothing (the next tap connects). */
    fun toggle(ctx: Context) { if (VpnState.current.phase == VpnState.Phase.STOPPING) return; if (isOn()) stop(ctx) else start(ctx) }

    fun stop(ctx: Context) {
        if (isOn()) BestVpnService.stop(ctx)
    }

    /** Starts the saved connection; false when the app had to be opened instead. */
    fun start(ctx: Context): Boolean {
        if (isOn()) return true
        val session = Session.load(ctx)
        val needsPermission = session == null || (session.mode == "vpn" && try { VpnService.prepare(ctx) != null } catch (_: Exception) { true })
        if (session == null || needsPermission) {
            openApp(ctx)
            return false
        }
        return try {
            BestVpnService.start(ctx, session)
            true
        } catch (_: Exception) {
            openApp(ctx)
            false
        }
    }

    fun openApp(ctx: Context) {
        try {
            ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { }
    }
}
