#!/bin/sh
# Point the mailflow_api upstream at BACKEND_HOST:BACKEND_PORT (#436).
#
# The compose default is the Docker service name (backend:3000), which is wrong everywhere
# the backend is named something else — Kubernetes services, Podman pods, split hosts. The
# only prior escape hatch was replacing the whole nginx.conf by hand.
#
# Same shape as 16-detect-resolver.sh, for the same two scars: rendering the config through
# envsubst at boot made /etc/nginx/conf.d a startup write and stopped read-only root
# filesystems from booting (#453), so exactly one marked line is rewritten in place, and a
# failed rewrite is survivable (the shipped default stands). The rules that keep this from
# becoming another regression:
#   1. Never exit non-zero. The image's entrypoint runs under `set -e`.
#   2. Any write goes through a command (sed) whose failure is an ordinary non-zero — in ash
#      a failed REDIRECTION kills the whole script.
#   3. Only ever touch our own marked line, so an operator-supplied config is left alone.
#   4. The values land inside nginx config syntax, so anything that could not be a hostname
#      or port is refused rather than written.
set -u

CONF=/etc/nginx/conf.d/default.conf
MARK='# mailflow-backend-managed'

# Nothing requested: the shipped default stands, silently.
[ -z "${BACKEND_HOST:-}" ] && [ -z "${BACKEND_PORT:-}" ] && exit 0

HOST=${BACKEND_HOST:-backend}
PORT=${BACKEND_PORT:-3000}

# Hostname label / IPv4 characters only — a value that could close the directive or open
# another one never reaches the config. (A bracketed IPv6 literal is deliberately not
# supported: brackets inside an sh bracket class are exactly the kind of quoting trap that
# made the first draft of this guard silently match nothing.)
case "$HOST" in
  *[!A-Za-z0-9._-]*|'')
    echo "$0: BACKEND_HOST '$HOST' is not a plain hostname or IPv4 address; keeping the shipped default"
    exit 0 ;;
esac
case "$PORT" in
  *[!0-9]*|'')
    echo "$0: BACKEND_PORT '$PORT' is not a port number; keeping the shipped default"
    exit 0 ;;
esac

[ -f "$CONF" ] || { echo "$0: $CONF absent; nothing to do"; exit 0; }

if ! grep -q "$MARK" "$CONF" 2>/dev/null; then
  echo "$0: no managed backend line in $CONF (custom config?); leaving it untouched"
  exit 0
fi

# Matches on the marker rather than the current value, so this is idempotent across restarts.
if sed -i "s|^\( *\)server .*${MARK}\$|\1server ${HOST}:${PORT} resolve; ${MARK}|" "$CONF" 2>/dev/null; then
  echo "$0: backend upstream set to ${HOST}:${PORT}"
else
  echo "$0: cannot write $CONF (read-only filesystem?); keeping the shipped default"
fi

exit 0
