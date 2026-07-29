#!/bin/bash
# deploy.sh — rebuild the server and restart it. The whole of CI/CD.
#
# Triggered by hookd on a push webhook, or run by hand. See DEPLOY.md.
#
#   fetch -> reset --hard -> clean build -> restart -> health check
#                                                |
#                                    fail -> roll back to the previous
#                                            commit and rebuild it
set -uo pipefail

CONF=${CONF:-/etc/garden/garden.conf}
[ -r "$CONF" ] && . "$CONF"

REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")" && pwd)}
GARDEN_PORT=${GARDEN_PORT:-8000}
STATE_DIR=${STATE_DIR:-/var/lib/garden}
LOG=$STATE_DIR/deploy.log
HEALTH_TRIES=${HEALTH_TRIES:-20}

mkdir -p "$STATE_DIR"
log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

# One at a time. Two pushes a second apart would otherwise interleave a hard
# reset with the other's build, and the binary belongs to neither commit.
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || { log "deploy: another deploy holds the lock"; exit 75; }

cd "$REPO_DIR" || { log "deploy: no repo at $REPO_DIR"; exit 1; }

BRANCH=$(git symbolic-ref --short -q HEAD || echo main)
PREV=$(git rev-parse HEAD)
log "deploy: start  branch=$BRANCH  from=$PREV"

# hookd is what invoked this script, so it is the one thing that cannot
# restart itself here. Watch the source, not the binary: the binary is rebuilt
# every time whether or not anything about it changed.
hookd_hash() { md5sum "$REPO_DIR/src/hookd.c" 2>/dev/null | cut -d' ' -f1; }
HOOKD_BEFORE=$(hookd_hash)

git fetch --prune origin >>"$LOG" 2>&1 || {
    log "deploy: FAILED to fetch origin (is the remote reachable and readable?)"; exit 1; }
git reset --hard "origin/$BRANCH" >>"$LOG" 2>&1 || {
    log "deploy: FAILED to reset to origin/$BRANCH"; exit 1; }

NEW=$(git rev-parse HEAD)
log "deploy: now at $NEW  ($(git log -1 --pretty=%s))"

# `clean` is not optional. A hard reset rewrites every source mtime to now
# while the old objects keep theirs, which is enough for make to get the
# comparison wrong occasionally — and be wrong by serving the old code while
# reporting success. Nothing here should reason about mtimes.
build() { make clean >>"$LOG" 2>&1 && make >>"$LOG" 2>&1; }

# Up means answering, not "systemd started it": the socket is bound before
# lua is loaded, and a broken render.lua still binds.
healthy() {
    for _ in $(seq 1 "$HEALTH_TRIES"); do
        curl -fs -m 3 -o /dev/null "http://127.0.0.1:$GARDEN_PORT/" && return 0
        sleep 0.5
    done
    return 1
}

rollback() {
    log "deploy: ROLLING BACK to $PREV"
    git reset --hard "$PREV" >>"$LOG" 2>&1
    if build && sudo systemctl restart garden && healthy; then
        log "deploy: rolled back, site is up on the old commit"
    else
        log "deploy: ROLLBACK FAILED — site is down, ssh required"
    fi
    exit 1
}

build                              || { log "deploy: BUILD FAILED at $NEW";      rollback; }
sudo systemctl restart garden      || { log "deploy: restart FAILED";            rollback; }
healthy                            || { log "deploy: health check FAILED";       rollback; }

# Written only here, once the build and the health check have both passed, so
# /api/status can never claim a commit that is not the one answering.
printf '%s' "$NEW" > "$STATE_DIR/deployed.sha"
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/deployed.at"
log "deploy: OK  $PREV -> $NEW"

# Restarting garden-hook from inside its own cgroup would kill this process
# mid-sentence, so systemd is asked to do it once we have exited.
if [ "$(hookd_hash)" != "$HOOKD_BEFORE" ]; then
    log "deploy: src/hookd.c changed, scheduling detached restart"
    sudo systemd-run --collect --on-active=2 --unit=garden-hook-restart \
        /bin/systemctl restart garden-hook >>"$LOG" 2>&1 \
        || log "deploy: WARNING could not schedule hookd restart"
fi
