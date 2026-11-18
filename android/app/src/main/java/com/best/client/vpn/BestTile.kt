package com.best.client.vpn

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.best.client.MainActivity
import com.best.client.R

/**
 * Quick Settings tile: connects the last used config or disconnects, without opening Best.
 * When Android still has to allow the VPN (first time, or another VPN took over), Best is opened
 * instead, because only an app on screen may ask for it.
 */
class BestTile : TileService() {

    private var unsubscribe: (() -> Unit)? = null

    override fun onStartListening() {
        super.onStartListening()
        unsubscribe = VpnState.onState { update(it) }
        update(VpnState.current)
    }

    override fun onStopListening() {
        unsubscribe?.invoke()
        unsubscribe = null
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        if (VpnToggle.isOn()) { VpnToggle.stop(this); return }
        val session = Session.load(this)
        val needsPermission = session == null || (session.mode == "vpn" && try { VpnService.prepare(this) != null } catch (_: Exception) { true })
        if (needsPermission) openApp() else if (!VpnToggle.start(this)) openApp()
    }

    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }

    private fun update(s: VpnState.Snapshot) {
        val tile = qsTile ?: return
        tile.state = when (s.phase) {
            VpnState.Phase.CONNECTED -> Tile.STATE_ACTIVE
            VpnState.Phase.CONNECTING, VpnState.Phase.STOPPING -> Tile.STATE_ACTIVE
            else -> Tile.STATE_INACTIVE
        }
        tile.icon = Icon.createWithResource(this, R.drawable.ic_stat_best)
        tile.label = getString(R.string.app_name)
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = s.name.takeIf { s.phase == VpnState.Phase.CONNECTED }?.take(40)
        tile.updateTile()
    }
}
