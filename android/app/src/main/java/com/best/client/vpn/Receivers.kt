package com.best.client.vpn

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews
import com.best.client.R
import com.best.client.data.Store
import org.json.JSONObject

/** Options the page keeps in its "ui" store that the receivers below need. */
internal fun uiFlag(ctx: Context, key: String): Boolean = try {
    JSONObject(Store(ctx).read("ui") ?: "{}").optBoolean(key, false)
} catch (_: Exception) {
    false
}

/** "Connect after the phone starts": the last connection, only when the user turned it on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!uiFlag(ctx, "bootConnect")) return
        val session = Session.load(ctx) ?: return
        val allowed = session.mode != "vpn" || try { android.net.VpnService.prepare(ctx) == null } catch (_: Exception) { false }
        if (!allowed) return
        try { BestVpnService.start(ctx, session) } catch (_: Exception) { }
    }
}

/** Home-screen widget: one tap connects or disconnects; shows the state and the config's name. */
class BestWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) = update(ctx, manager, ids)

    companion object {
        fun refresh(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx) ?: return
            val ids = manager.getAppWidgetIds(ComponentName(ctx, BestWidget::class.java))
            if (ids.isNotEmpty()) update(ctx, manager, ids)
        }

        private fun update(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
            val s = VpnState.current
            val on = s.phase == VpnState.Phase.CONNECTED
            val busy = s.phase == VpnState.Phase.CONNECTING || s.phase == VpnState.Phase.STOPPING
            val tap = PendingIntent.getBroadcast(
                ctx, 0, Intent(ctx, WidgetToggleReceiver::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            for (id in ids) {
                val v = RemoteViews(ctx.packageName, R.layout.widget_best)
                v.setImageViewResource(R.id.widget_power, if (on) R.drawable.widget_power_on else R.drawable.widget_power_off)
                v.setTextViewText(R.id.widget_state, ctx.getString(if (on) R.string.widget_on else if (busy) R.string.widget_busy else R.string.widget_off))
                v.setTextViewText(R.id.widget_name, (s.name.ifBlank { Session.load(ctx)?.name ?: "" }).take(40))
                v.setOnClickPendingIntent(R.id.widget_root, tap)
                manager.updateAppWidget(id, v)
            }
        }
    }
}

/** The widget's tap. Not exported: only the widget's own PendingIntent reaches it. */
class WidgetToggleReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        VpnToggle.toggle(ctx)
    }
}

/**
 * Launcher shortcut "Connect / disconnect": toggles and closes at once. Not exported; started by
 * the launcher on Best's behalf through its published shortcut.
 */
class ShortcutActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        VpnToggle.toggle(this)
        finish()
    }
}

/**
 * Tasker (and other "Locale" plug-in hosts): connect, disconnect or toggle. Off unless the user
 * allows it in Best's settings, because any app on the phone could send this request.
 */
class TaskerReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ACTION_FIRE || !uiFlag(ctx, "allowTasker")) return
        // Extras from another app: a broken one must not bring Best (and its VPN) down.
        val action = try { intent.getBundleExtra(EXTRA_BUNDLE)?.getString(KEY_ACTION) ?: intent.getStringExtra(KEY_ACTION) } catch (_: Exception) { null }
        when (action) {
            "start" -> VpnToggle.start(ctx)
            "stop" -> VpnToggle.stop(ctx)
            "toggle" -> VpnToggle.toggle(ctx)
        }
    }

    companion object {
        const val ACTION_FIRE = "com.twofortyfouram.locale.intent.action.FIRE_SETTING"
        const val EXTRA_BUNDLE = "com.twofortyfouram.locale.intent.extra.BUNDLE"
        const val EXTRA_BLURB = "com.twofortyfouram.locale.intent.extra.BLURB"
        const val KEY_ACTION = "best_action"
    }
}

/** Tasker's "edit" screen: pick what the action does. */
class TaskerEditActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val keys = arrayOf("start", "stop", "toggle")
        val labels = arrayOf(getString(R.string.tasker_start), getString(R.string.tasker_stop), getString(R.string.tasker_toggle))
        AlertDialog.Builder(this)
            .setTitle(R.string.app_name)
            .setItems(labels) { _, which ->
                val bundle = Bundle().apply { putString(TaskerReceiver.KEY_ACTION, keys[which]) }
                setResult(RESULT_OK, Intent()
                    .putExtra(TaskerReceiver.EXTRA_BUNDLE, bundle)
                    .putExtra(TaskerReceiver.EXTRA_BLURB, labels[which]))
                finish()
            }
            .setOnCancelListener { setResult(RESULT_CANCELED); finish() }
            .show()
    }
}
