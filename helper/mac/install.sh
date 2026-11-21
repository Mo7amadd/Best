#!/bin/sh
# Installs Best's TUN helper (run as root, after the user typed their password in the macOS prompt).
#   install.sh <helper program> <sing-box program> <owner's user id> <helper SHA-256> <sing-box SHA-256>
# Best passes this script's text itself (it is not read from the app folder as root). The two programs
# are copied into a root-owned folder and must then have exactly the SHA-256 Best computed before
# the prompt: nothing changed in the user's app folder meanwhile is ever run as root.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
helper="$1"; singbox="$2"; owner="$3"; helper_sha="$4"; singbox_sha="$5"
case "$owner" in ''|*[!0-9]*) echo "bad user id" >&2; exit 2 ;; esac
for h in "$helper_sha" "$singbox_sha"; do
  printf '%s' "$h" | grep -Eq '^[0-9a-f]{64}$' || { echo "bad checksum" >&2; exit 2; }
done
for f in "$helper" "$singbox"; do
  [ -f "$f" ] && [ ! -L "$f" ] || { echo "$f is missing or a link" >&2; exit 2; }
done

label=com.best.client.tun
dir=/Library/PrivilegedHelperTools/$label
plist=/Library/LaunchDaemons/$label.plist
sha() { /usr/bin/openssl dgst -sha256 -r "$1" | cut -d' ' -f1; }

# A running helper stops its TUN when launchd stops it.
launchctl bootout "system/$label" 2>/dev/null || true
rm -rf "$dir"
mkdir -p /Library/PrivilegedHelperTools
mkdir -m 700 "$dir"
cp "$helper" "$dir/best-tun-helper"
cp "$singbox" "$dir/sing-box"
if [ "$(sha "$dir/best-tun-helper")" != "$helper_sha" ] || [ "$(sha "$dir/sing-box")" != "$singbox_sha" ]; then
  rm -rf "$dir"
  echo "the programs changed while the password was asked; nothing was installed" >&2
  exit 3
fi
printf '%s\n' "$owner" > "$dir/owner"
chown -R root:wheel "$dir"
chmod 755 "$dir" "$dir/best-tun-helper" "$dir/sing-box"
chmod 644 "$dir/owner"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>Program</key><string>$dir/best-tun-helper</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
chown root:wheel "$plist"
chmod 644 "$plist"
launchctl bootstrap system "$plist"
