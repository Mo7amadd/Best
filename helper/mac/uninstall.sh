#!/bin/sh
# Removes Best's TUN helper (run as root). Stopping it also stops a running TUN.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
label=com.best.client.tun
launchctl bootout "system/$label" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/$label.plist" "/var/run/$label.socket"
rm -rf "/Library/PrivilegedHelperTools/$label"
exit 0
