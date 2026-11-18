package com.best.client.vpn

/**
 * Starting an Xray instance passes the VPN interface through a process-wide setting
 * (xray.tun.fd), so instances (the connection, speed / UDP tests) are started one at a time.
 */
object CoreLock
