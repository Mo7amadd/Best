package com.best.client.vpn

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.best.client.BestApp
import com.best.client.MainActivity
import com.best.client.R
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import libv2ray.CoreCallbackHandler
import libv2ray.CoreController
import libv2ray.Libv2ray

/**
 * The VPN: Android gives a TUN interface, Xray reads it directly (its "tun" inbound) and sends
 * the traffic to the chosen server. Best itself is always left out of the tunnel, so Xray's own
 * connections to the server never loop back into it.
 *
 * All start / stop work runs on one worker thread, in order.
 */
class BestVpnService : VpnService() {

    private val worker: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "best-vpn") }
    private val main = Handler(Looper.getMainLooper())

    private var ticker: ScheduledExecutorService? = null
    private var tun: ParcelFileDescriptor? = null
    private var core: CoreController? = null
    private var sing: SingBox.Running? = null
    private var session: Session? = null
    private var upTotal = 0L
    private var downTotal = 0L
    private var ticks = 0

    /**
     * Counts start requests (main thread). A stop leaves the foreground and ends the service later,
     * on the main thread; if a new start arrived in between (a quick tap while disconnecting), that
     * late stop would end the new connection too, so it is skipped when this number moved on.
     */
    @Volatile private var starts = 0

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            worker.execute { stopVpn() }
            return START_NOT_STICKY
        }
        // ACTION_START from the UI, or the system starting "Always-on VPN" (no action / SERVICE_INTERFACE).
        val s = Session.load(this)
        if (s == null) {
            VpnState.set(VpnState.Snapshot(VpnState.Phase.ERROR, error = "NO_SESSION"))
            stopSelf()
            return START_NOT_STICKY
        }
        starts++
        goForeground(s, connected = false, detail = null)
        worker.execute { startVpn(s) }
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        // Another VPN app took over, or the user turned Best off in Android's settings.
        worker.execute { stopVpn() }
    }

    override fun onDestroy() {
        worker.execute {
            val wasUp = core != null || tun != null
            teardown()
            // Never left showing "connected" with no tunnel.
            if (wasUp || VpnState.current.phase != VpnState.Phase.ERROR) VpnState.set(VpnState.Snapshot(VpnState.Phase.IDLE))
        }
        worker.shutdown()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- start / stop (worker thread)

    private fun startVpn(s: Session) {
        teardown()
        session = s
        VpnState.set(VpnState.Snapshot(VpnState.Phase.CONNECTING, s.name))
        Logs.add(this, "info", "Best", "Connecting: ${s.name}${if (s.singbox != null) " (Xray + sing-box)" else ""}${if (s.mode == "proxy") ", proxy only" else ""}")
        try {
            GeoFiles.ensure(this)
            // "Proxy only": no VPN interface; apps that have proxy settings use the local ports.
            val pfd = if (s.mode == "proxy") null else
                // Some systems (PC emulators, old kernels) refuse an IPv6 address on the tunnel;
                // they have no IPv6 either, so nothing can go around the VPN without it.
                (try { buildTunnel(s, ipv6 = true).establish() } catch (e: Exception) { Log.w(TAG, "tunnel with IPv6", e); null })
                    ?: buildTunnel(s, ipv6 = false).establish()
                    ?: throw IllegalStateException("VPN_NOT_ALLOWED")
            tun = pfd
            // Servers Xray can't open: sing-box first, then Xray hands it the traffic.
            val config = s.singbox?.let { sb ->
                val running = SingBox.start(this, sb, "vpn")
                sing = running
                SingBox.linkXray(s.config, running)
            } ?: s.config
            val (withFetch, fetch) = addFetchInbound(withLogs(config, s))
            val c = Libv2ray.newCoreController(CoreCallbacks)
            // Xray takes the VPN interface from a process-wide setting: one start at a time.
            synchronized(CoreLock) { c.startLoop(withFetch, pfd?.fd ?: 0) }
            core = c
            VpnState.tunnel = fetch
            upTotal = 0
            downTotal = 0
            VpnState.setTraffic(VpnState.Traffic(0, 0, 0, 0))
            VpnState.set(VpnState.Snapshot(VpnState.Phase.CONNECTED, s.name, since = SystemClock.elapsedRealtime()))
            Logs.add(this, "info", "Best", "Connected: ${s.name}")
            main.post { goForeground(s, connected = true, detail = null) }
            startTicker()
        } catch (e: Exception) {
            Log.w(TAG, "start failed", e)
            val asked = starts
            teardown()
            Logs.add(this, "error", "Best", "Could not connect (${errorCode(e)}): ${(e.message ?: e.javaClass.simpleName).take(200)}")
            VpnState.set(VpnState.Snapshot(VpnState.Phase.ERROR, s.name, error = errorCode(e)))
            main.post { if (starts == asked) leaveForeground() }
        }
    }

    private fun failed(name: String, code: String) {
        Logs.add(this, "error", "Best", "Connection stopped ($code): $name")
        val asked = starts
        teardown()
        VpnState.set(VpnState.Snapshot(VpnState.Phase.ERROR, name, error = code))
        main.post { if (starts == asked) leaveForeground() }
    }

    private fun stopVpn() {
        if (core != null || tun != null) {
            VpnState.set(VpnState.Snapshot(VpnState.Phase.STOPPING, session?.name ?: ""))
            Logs.add(this, "info", "Best", "Disconnected")
        }
        val asked = starts
        teardown()
        VpnState.set(VpnState.Snapshot(VpnState.Phase.IDLE))
        main.post { if (starts == asked) leaveForeground() }
    }

    /**
     * Adds Best's own SOCKS inbound (127.0.0.1, random port, user and password) that sends Best's
     * requests through the server: subscriptions and updates then work even where they are
     * blocked, and the server sees the proxy's address, not the phone's.
     */
    private fun addFetchInbound(config: String): Pair<String, com.best.client.net.Socks.Endpoint> {
        val ep = com.best.client.net.Socks.Endpoint(com.best.client.net.Local.freePort(), com.best.client.net.Local.token(), com.best.client.net.Local.token())
        val json = org.json.JSONObject(config)
        val inbounds = json.optJSONArray("inbounds") ?: org.json.JSONArray().also { json.put("inbounds", it) }
        inbounds.put(org.json.JSONObject()
            .put("tag", FETCH_TAG)
            .put("listen", "127.0.0.1")
            .put("port", ep.port)
            .put("protocol", "socks")
            .put("settings", org.json.JSONObject()
                .put("auth", "password")
                .put("accounts", org.json.JSONArray().put(org.json.JSONObject().put("user", ep.user).put("pass", ep.pass)))
                .put("udp", false)))
        // Always through the proxy (or the group's balancer); a full JSON config without a "proxy"
        // outbound uses its first outbound, Xray's default.
        val routing = json.optJSONObject("routing") ?: org.json.JSONObject().also { json.put("routing", it) }
        val rules = routing.optJSONArray("rules") ?: org.json.JSONArray()
        val balancers = routing.optJSONArray("balancers")
        val hasBalancer = balancers != null && (0 until balancers.length()).any { balancers.optJSONObject(it)?.optString("tag") == "proxy" }
        val outs = json.optJSONArray("outbounds")
        val hasProxy = outs != null && (0 until outs.length()).any { outs.optJSONObject(it)?.optString("tag") == "proxy" }
        // A full JSON config without a "proxy" outbound: its first outbound, named here if it has no
        // name, so the config's own rules (a "private addresses direct" rule, say) never apply to Best's requests.
        val first = outs?.optJSONObject(0)
        if (!hasBalancer && !hasProxy && first != null && first.optString("tag").isEmpty()) first.put("tag", "best-first")
        val target = if (hasBalancer || hasProxy) "proxy" else first?.optString("tag").orEmpty()
        if (target.isNotEmpty()) {
            val rule = org.json.JSONObject().put("type", "field").put("inboundTag", org.json.JSONArray().put(FETCH_TAG))
            if (hasBalancer) rule.put("balancerTag", "proxy") else rule.put("outboundTag", target)
            val next = org.json.JSONArray().put(rule)
            for (i in 0 until rules.length()) next.put(rules.get(i))
            routing.put("rules", next)
        }
        return json.toString() to ep
    }

    /** Xray's logs go to Best's private folder (see Logs); emptied at each connection. */
    private fun withLogs(config: String, s: Session): String {
        Logs.cut(Logs.access(this))
        val json = org.json.JSONObject(config)
        val log = json.optJSONObject("log") ?: org.json.JSONObject()
        val level = log.optString("loglevel", "warning").takeIf { it in LEVELS } ?: "warning"
        log.put("loglevel", level)
        log.put("error", if (level == "none") "" else Logs.error(this).path)
        log.put("access", if (s.logAccess) Logs.access(this).path else "none")
        log.put("dnsLog", false)
        json.put("log", log)
        return json.toString()
    }

    private fun teardown() {
        VpnState.tunnel = null
        ticker?.shutdownNow()
        ticker = null
        core?.let {
            try { it.stopLoop() } catch (e: Exception) { Log.w(TAG, "stopLoop", e) }
        }
        core = null
        sing?.stop()
        sing = null
        try { tun?.close() } catch (_: Exception) { }
        tun = null
    }

    private fun buildTunnel(s: Session, ipv6: Boolean): Builder {
        val b = Builder()
            .setSession("Best")
            .setMtu(s.mtu)
            .addAddress(TUN_V4, 30)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(TUN_DNS_V4)
            .setConfigureIntent(openAppIntent())
        // IPv6 always enters the tunnel (otherwise it would go around the VPN); the config
        // refuses it inside when IPv6 is turned off.
        if (ipv6) b.addAddress(TUN_V6, 126).addRoute("::", 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setMetered(false)

        var onlySome = false
        if (s.appMode == "include") {
            for (p in s.apps) {
                if (p == packageName) continue
                try { b.addAllowedApplication(p); onlySome = true } catch (_: PackageManager.NameNotFoundException) { }
            }
        }
        if (!onlySome) {
            // Best's own traffic (Xray's connection to the server) must never enter the tunnel.
            b.addDisallowedApplication(packageName)
            if (s.appMode == "exclude") {
                for (p in s.apps) {
                    if (p == packageName) continue
                    try { b.addDisallowedApplication(p) } catch (_: PackageManager.NameNotFoundException) { }
                }
            }
        }
        return b
    }

    // ---------------------------------------------------------------- traffic counters

    private fun startTicker() {
        val t = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "best-stats") }
        ticker = t
        ticks = 0
        t.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
    }

    /** Counters are read and reset each second, so the values are bytes per second. */
    private fun tick() {
        val c = core ?: return
        // sing-box ended by itself: without it nothing gets through, so the connection stops
        // and says why instead of looking connected.
        sing?.let { sb ->
            if (!sb.alive && !sb.stopping) {
                sb.stopping = true
                worker.execute { failed(session?.name ?: "", "SINGBOX_STOPPED") }
                return
            }
        }
        val raw = try { c.queryAllOutboundTrafficStats() } catch (_: Exception) { return }
        var up = 0L
        var down = 0L
        for (entry in raw.split(';')) {
            val parts = entry.split(',')
            if (parts.size != 3 || parts[0] in LOCAL_TAGS) continue
            val v = parts[2].toLongOrNull() ?: continue
            if (parts[1] == "uplink") up += v else if (parts[1] == "downlink") down += v
        }
        upTotal += up
        downTotal += down
        if (ticks % 30 == 0) Logs.trim(this)
        VpnState.setTraffic(VpnState.Traffic(up, down, upTotal, downTotal))
        // The notification is refreshed every 2 s (Android throttles faster updates anyway).
        if (++ticks % 2 == 0) {
            val s = session ?: return
            val detail = "↓ ${rate(down)}  ↑ ${rate(up)}"
            main.post { if (core != null) goForeground(s, connected = true, detail = detail) }
        }
    }

    // ---------------------------------------------------------------- notification

    private fun goForeground(s: Session, connected: Boolean, detail: String?) {
        val n = notification(s, connected, detail)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
    }

    private fun leaveForeground() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(s: Session, connected: Boolean, detail: String?): Notification {
        val text = listOfNotNull(s.name.ifBlank { null }, detail).joinToString(" · ")
        return NotificationCompat.Builder(this, BestApp.CHANNEL_VPN)
            .setSmallIcon(R.drawable.ic_stat_best)
            .setColor(ContextCompat.getColor(this, R.color.accent))
            .setContentTitle(if (connected) s.textConnected else s.textConnecting)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openAppIntent())
            .addAction(0, s.textDisconnect, stopIntent())
            .build()
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun stopIntent(): PendingIntent = PendingIntent.getService(
        this, 1,
        Intent(this, BestVpnService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private object CoreCallbacks : CoreCallbackHandler {
        override fun startup(): Long = 0
        override fun shutdown(): Long = 0
        override fun onEmitStatus(code: Long, message: String?): Long = 0
    }

    companion object {
        private const val FETCH_TAG = "best-fetch"
        private const val TAG = "BestVpn"
        const val ACTION_START = "com.best.client.vpn.START"
        const val ACTION_STOP = "com.best.client.vpn.STOP"
        private const val NOTIFICATION_ID = 1
        private const val TUN_V4 = "172.19.0.1"
        private const val TUN_DNS_V4 = "172.19.0.2"
        private const val TUN_V6 = "fdfe:dcba:9876::1"

        /** Outbounds that are not traffic to the server. */
        private val LOCAL_TAGS = setOf("direct", "block", "dns-out", "loop-out")
        private val LEVELS = setOf("debug", "info", "warning", "error", "none")

        fun start(ctx: Context, s: Session) {
            Session.save(ctx, s)
            ContextCompat.startForegroundService(ctx, Intent(ctx, BestVpnService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, BestVpnService::class.java).setAction(ACTION_STOP))
        }

        /** Short, UI-translatable error codes; details stay in the debug log. */
        private fun errorCode(e: Exception): String {
            val m = e.message.orEmpty()
            return when {
                m == "VPN_NOT_ALLOWED" || m == "NEEDS_SINGBOX" || m == "SINGBOX_START" || m == "CORE_CONFIG" -> m
                m.startsWith("config error") -> "CORE_CONFIG"
                m.startsWith("core init failed") -> "CORE_INIT"
                m.startsWith("startup failed") -> "CORE_START"
                else -> "CORE_FAILED"
            }
        }

        fun rate(bytesPerSecond: Long): String {
            val b = bytesPerSecond.toDouble()
            return when {
                b >= 1024 * 1024 -> String.format(Locale.US, "%.1f MB/s", b / (1024 * 1024))
                b >= 1024 -> String.format(Locale.US, "%.0f KB/s", b / 1024)
                else -> "${bytesPerSecond} B/s"
            }
        }
    }
}
