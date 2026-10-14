#!/usr/bin/env bash
# Sets up the VBuddy relay on a fresh Ubuntu 22.04/24.04 VM (made for Oracle Cloud's free tier).
# Run it from the webapp folder you copied to the VM:   sudo bash deploy/relay/setup.sh mycockpit.duckdns.org
# Running it again updates the relay and keeps the registered bridges.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash deploy/relay/setup.sh your-address.example.org" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 2
fi
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "== Packages"
apt-get update -y
apt-get install -y rsync curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi
corepack enable
corepack prepare pnpm@10.28.0 --activate

echo "== Relay files"
id vbuddy >/dev/null 2>&1 || useradd --system --home /var/lib/vbuddy-relay --create-home --shell /usr/sbin/nologin vbuddy
mkdir -p /opt/vbuddy /var/lib/vbuddy-relay/.vbuddy-relay
rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude 'packages/web' --exclude 'packages/bridge' "$SRC"/ /opt/vbuddy/
mkdir -p /opt/vbuddy/packages
cd /opt/vbuddy
# Only the relay and the shared protocol are needed here.
pnpm install --filter "@vbuddy/relay..." --frozen-lockfile=false
pnpm --filter "@vbuddy/protocol" build
pnpm --filter "@vbuddy/relay" build
chown -R vbuddy:vbuddy /var/lib/vbuddy-relay

# The registry of bridges (id -> hash of its key) lives here and is kept across updates.
chown -R vbuddy:vbuddy /var/lib/vbuddy-relay
# Older versions used one shared secret for a single bridge; it is not used any more.
rm -f /var/lib/vbuddy-relay/.vbuddy-relay/secret

echo "== Services"
cp deploy/relay/vbuddy-relay.service /etc/systemd/system/vbuddy-relay.service
sed "s/{\$VBUDDY_DOMAIN}/$DOMAIN/" deploy/relay/Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable vbuddy-relay
# restart (not just start): when updating, the old relay process is still running the old code
systemctl restart vbuddy-relay
systemctl restart caddy

echo "== Firewall (Oracle's Ubuntu images block everything but SSH by default)"
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; else apt-get install -y iptables-persistent && netfilter-persistent save; fi
fi

echo
echo "Done. Relay address:  wss://$DOMAIN   (check https://$DOMAIN/relay/health)"
echo "Nothing to copy to the PCs: each VBuddy install registers itself with its own id and key the first time it connects."
echo "Still needed: in the Oracle console, allow ingress TCP 80 and 443 in the VM's security list, and point $DOMAIN at this VM's public IP."
