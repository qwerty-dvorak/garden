#!/bin/bash
# bootstrap.sh — the one time you need ssh. See DEPLOY.md.
#
#     SERVER_NAMES="example.com www.example.com" ./deploy/bootstrap.sh
#
# Idempotent. SERVER_NAMES is remembered in the config, so later runs can
# leave it out; the secret is never regenerated, because doing so silently
# would break an existing webhook and look like a network fault.
set -euo pipefail

REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
CONF=/etc/garden/garden.conf
STATE_DIR=/var/lib/garden
USER_NAME=${SUDO_USER:-$USER}

say() { printf '\n== %s\n' "$*"; }

# Passed in wins, then whatever a previous run stored, then any name at all.
SERVER_NAMES=${SERVER_NAMES:-$(sudo sed -n 's/^SERVER_NAMES=//p' "$CONF" 2>/dev/null | head -1)}
SERVER_NAMES=${SERVER_NAMES:-_}

# The units and the vhost carry no hostname, user or path of their own — they
# are templates, and this is the only place that knows where it is installed.
render() {
    sed -e "s|__SERVER_NAMES__|$SERVER_NAMES|" \
        -e "s|__REPO_DIR__|$REPO_DIR|" \
        -e "s|__USER__|$USER_NAME|" "$1"
}

say "config at $CONF"
sudo mkdir -p /etc/garden "$STATE_DIR"
if [ ! -f "$CONF" ]; then
    sudo tee "$CONF" > /dev/null <<CONF_EOF
# Shell-sourceable, so deploy.sh and hookd read the same file rather than two
# that drift apart. Outside the repo, because deploy.sh runs a hard reset and
# a secret in the working tree would be destroyed by it — or committed.
DEPLOY_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
REPO_DIR=$REPO_DIR
HOOK_PORT=8001
GARDEN_PORT=8000
STATE_DIR=$STATE_DIR
GALLERY_MAX=100
GALLERY_MAX_BYTES=2048
SERVER_NAMES=$SERVER_NAMES
CONF_EOF
    echo "  generated a secret"
else
    echo "  keeping the existing secret"
fi

# root writes it, the service user reads it.
sudo chown "root:$USER_NAME" "$CONF"
sudo chmod 640 "$CONF"
sudo chown "$USER_NAME:$USER_NAME" "$STATE_DIR"

say "build"
cd "$REPO_DIR"
make clean
make
./hookd -t

say "units"
for unit in garden garden-hook; do
    render "$REPO_DIR/deploy/$unit.service" | sudo tee "/etc/systemd/system/$unit.service" > /dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable garden garden-hook
sudo systemctl restart garden garden-hook

say "nginx"
render "$REPO_DIR/deploy/nginx-garden.conf" | sudo tee /etc/nginx/sites-available/garden > /dev/null
sudo ln -sfn /etc/nginx/sites-available/garden /etc/nginx/sites-enabled/garden
sudo nginx -t
sudo systemctl reload nginx

say "health"
for _ in $(seq 1 20); do
    curl -fs -m 3 -o /dev/null http://127.0.0.1:8000/ && break
    sleep 0.5
done
curl -fsS -m 5 -o /dev/null -w '  garden  %{http_code}\n' http://127.0.0.1:8000/
curl -fsS -m 5 -w '  hookd   %{http_code}  ' http://127.0.0.1:8001/api/status; echo

cat <<'NEXT'

== one thing left, on github, one time

  settings/hooks/new
    url            http://<your host>/deploy
    content type   application/json
    secret         sudo grep DEPLOY_SECRET /etc/garden/garden.conf
    events         just the push event

A public repo clones over https, so the box needs no key and no credentials
of any kind. After the webhook exists, a push is a deploy.
NEXT
