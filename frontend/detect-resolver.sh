#!/bin/sh
# Point nginx's resolver at whatever this container's /etc/resolv.conf actually names.
#
# The mailflow_api upstream uses `server backend:3000 resolve`, and `resolve` queries the
# address in nginx's own resolver directive rather than the system resolver. Hardcoding
# Docker's 127.0.0.11 broke every runtime without it — Podman puts DNS on the gateway,
# Kubernetes uses cluster DNS — so /api/ returned 502 and login failed there (#448).
#
# Rewriting one marked line in place, rather than rendering the config through envsubst,
# is deliberate: envsubst made /etc/nginx/conf.d a startup write, which stopped read-only
# root filesystems from booting at all (#453).
#
# Three rules keep this from becoming a third regression:
#   1. Never exit non-zero. The image's entrypoint runs under `set -e`.
#   2. Never let a failed write abort the script. In ash a failed REDIRECTION kills the
#      whole script regardless of exit code, so any write goes through a command (sed)
#      whose failure is an ordinary non-zero, not through `>`.
#   3. Only ever touch our own marked line, so an operator who supplies their own config
#      is left alone.
set -u

CONF=/etc/nginx/conf.d/default.conf
MARK='# mailflow-managed'

[ -f "$CONF" ] || { echo "$0: $CONF absent; nothing to do"; exit 0; }

# Same extraction the nginx image's own 15-local-resolvers.envsh uses: every nameserver in
# resolv.conf, IPv6 addresses bracketed as nginx requires.
RESOLVERS=$(awk 'BEGIN{ORS=" "} $1=="nameserver" {if ($2 ~ ":") {print "["$2"]"} else {print $2}}' /etc/resolv.conf 2>/dev/null)
RESOLVERS=${RESOLVERS% }

if [ -z "$RESOLVERS" ]; then
  echo "$0: /etc/resolv.conf names no nameserver; keeping the shipped resolver"
  exit 0
fi

if ! grep -q "$MARK" "$CONF" 2>/dev/null; then
  echo "$0: no managed resolver line in $CONF (custom config?); leaving it untouched"
  exit 0
fi

# Matches on the marker rather than the current value, so this is idempotent across restarts
# and still correct if the container's DNS changes between them.
if sed -i "s|^\( *\)resolver .*${MARK}\$|\1resolver ${RESOLVERS} valid=10s ipv6=off; ${MARK}|" "$CONF" 2>/dev/null; then
  echo "$0: resolver set to ${RESOLVERS}"
else
  echo "$0: cannot write $CONF (read-only filesystem?); keeping the shipped resolver"
fi

exit 0
