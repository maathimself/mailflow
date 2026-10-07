#!/bin/sh
# NGINX_TLS=off turns off the HTTPS server on port 443 (#516), for deployments behind a reverse
# proxy that terminates TLS itself and only uses the port 80 server. Unset or "on" keeps HTTPS,
# which is the default and is required by the bundled Caddy (the https profile proxies to 443).
# 10-generate-cert.sh reads the same variable and generates no certificate when it is off.
#
# Same shape as 16-detect-resolver.sh and 17-set-backend.sh, and the same rules:
#   1. Never exit non-zero. The image's entrypoint runs under `set -e`.
#   2. Any write goes through a command (sed) whose failure is an ordinary non-zero; in ash a
#      failed REDIRECTION kills the whole script.
#   3. Only ever touch our own marked block, so an operator-supplied config is left alone.
# Turning HTTPS off rewrites the config, so it needs a writable /etc/nginx/conf.d; on a
# read-only filesystem the shipped config, with HTTPS, stands.
#
# The block is commented out line by line with a prefix of our own and restored by removing
# it, so a restarted container follows a changed NGINX_TLS in either direction.
set -u

CONF=/etc/nginx/conf.d/default.conf
BEGIN='^# mailflow-tls-begin'
END='^# mailflow-tls-end'
PREFIX='#tls-off# '

case "$(printf '%s' "${NGINX_TLS:-on}" | tr 'A-Z' 'a-z')" in
  off|false|0|no) WANT=off ;;
  on|true|1|yes|'') WANT=on ;;
  *)
    echo "$0: NGINX_TLS '${NGINX_TLS}' is not on or off; keeping HTTPS on"
    WANT=on ;;
esac

[ -f "$CONF" ] || { echo "$0: $CONF absent; nothing to do"; exit 0; }

if ! grep -q "$BEGIN" "$CONF" 2>/dev/null || ! grep -q "$END" "$CONF" 2>/dev/null; then
  [ "$WANT" = off ] && echo "$0: no managed HTTPS block in $CONF (custom config?); leaving it untouched"
  exit 0
fi

if [ "$WANT" = off ]; then
  if sed -i "/${BEGIN}/,/${END}/{/^# mailflow-tls-/!{/^${PREFIX}/!s/^/${PREFIX}/}}" "$CONF" 2>/dev/null; then
    echo "$0: HTTPS server on port 443 turned off (NGINX_TLS=off); serving HTTP on port 80 only"
  else
    echo "$0: cannot write $CONF (read-only filesystem?); HTTPS stays on and needs a certificate in /etc/nginx/ssl"
  fi
elif grep -q "^${PREFIX}" "$CONF" 2>/dev/null; then
  # Turned off on an earlier start of this container; NGINX_TLS no longer says off.
  if sed -i "s/^${PREFIX}//" "$CONF" 2>/dev/null; then
    echo "$0: HTTPS server on port 443 turned back on"
  else
    echo "$0: cannot write $CONF (read-only filesystem?); HTTPS stays off as configured earlier"
  fi
fi

exit 0
