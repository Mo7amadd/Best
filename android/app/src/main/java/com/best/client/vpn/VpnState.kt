package com.best.client.vpn

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Connection state shared by the VPN service and the UI (same process). Listeners are always
 * called on the main thread.
 */
object VpnState {

    enum class Phase { IDLE, CONNECTING, CONNECTED, STOPPING, ERROR }

    data class Snapshot(
        val phase: Phase,
        val name: String = "",
        /** elapsedRealtime when the connection came up (0 when not connected). */
        val since: Long = 0,
        val error: String? = null,
    ) {
        val connectedForMs: Long get() = if (phase == Phase.CONNECTED && since > 0) SystemClock.elapsedRealtime() - since else 0
    }

    /** Bytes per second over the last tick, and totals since the connection came up. */
    data class Traffic(val upRate: Long, val downRate: Long, val upTotal: Long, val downTotal: Long)

    private val main = Handler(Looper.getMainLooper())
    private val stateListeners = CopyOnWriteArraySet<(Snapshot) -> Unit>()
    private val trafficListeners = CopyOnWriteArraySet<(Traffic) -> Unit>()

    @Volatile var current: Snapshot = Snapshot(Phase.IDLE)
        private set

    @Volatile var traffic: Traffic = Traffic(0, 0, 0, 0)
        private set

    /**
     * While connected: Best's own SOCKS inbound in the running Xray (random port and password),
     * through which Best sends its own requests (subscriptions, updates). Null otherwise.
     */
    @Volatile var tunnel: com.best.client.net.Socks.Endpoint? = null

    fun set(next: Snapshot) {
        current = next
        main.post { stateListeners.forEach { it(next) } }
    }

    fun setTraffic(next: Traffic) {
        traffic = next
        main.post { trafficListeners.forEach { it(next) } }
    }

    fun onState(l: (Snapshot) -> Unit): () -> Unit {
        stateListeners += l
        return { stateListeners -= l }
    }

    fun onTraffic(l: (Traffic) -> Unit): () -> Unit {
        trafficListeners += l
        return { trafficListeners -= l }
    }
}
