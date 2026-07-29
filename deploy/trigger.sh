#!/bin/bash
# trigger.sh — deploy by hand, from anywhere, without ssh.
#
#     HOST=http://example.com DEPLOY_SECRET=... ./deploy/trigger.sh
#     HOST=http://example.com ./deploy/trigger.sh status
#
# The real trigger is the webhook. This is the other door, for redeploying
# without pushing anything. There is no git post-push hook because git has no
# post-push hook: pre-push fires before the objects reach the remote, so a box
# that pulls would fetch a commit that does not exist yet.
set -euo pipefail

: "${HOST:?set HOST to the base url of the site, e.g. http://example.com}"

case "${1:-deploy}" in
  status)
    curl -fsS -m 10 "$HOST/api/status"; echo
    ;;
  deploy)
    : "${DEPLOY_SECRET:?sudo grep DEPLOY_SECRET /etc/garden/garden.conf}"
    curl -fsS -m 10 -X POST -H "Authorization: Bearer $DEPLOY_SECRET" "$HOST/deploy"
    echo
    echo "watch it land:  watch -n2 curl -s $HOST/api/status"
    ;;
  *)
    echo "usage: $0 [deploy|status]" >&2
    exit 2
    ;;
esac
