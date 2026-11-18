package com.best.client.net

import android.os.SystemClock
import android.util.Base64
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom

/** Local ports on 127.0.0.1 used between Best's own cores, with random credentials. */
object Local {

    val LOOPBACK: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    private val random = SecureRandom()

    /** A port nothing listens on right now. */
    fun freePort(): Int = ServerSocket(0, 1, LOOPBACK).use { it.localPort }

    /** 24 random URL-safe characters (144 bits). */
    fun token(): String {
        val b = ByteArray(18)
        random.nextBytes(b)
        return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    /** Waits until something accepts connections on `port`; `alive` false ends the wait early. */
    fun waitReady(port: Int, timeoutMs: Long, alive: () -> Boolean = { true }) {
        val until = SystemClock.elapsedRealtime() + timeoutMs
        while (true) {
            try {
                Socket().use { it.connect(InetSocketAddress(LOOPBACK, port), 300) }
                return
            } catch (_: Exception) {
                if (!alive() || SystemClock.elapsedRealtime() > until) throw IllegalStateException("CORE_START")
                Thread.sleep(60)
            }
        }
    }
}
