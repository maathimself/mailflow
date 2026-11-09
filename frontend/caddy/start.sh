#!/bin/sh
# Starts Caddy in the mode the environment asks for. Everything is passed to the Caddyfile as
# environment variables, so nothing is written under /etc and a read-only root filesystem boots
# (#453); the one write is a self-signed certificate, made only when none was supplied.
#
#   TLS_MODE      self-signed (default), letsencrypt or off. NGINX_TLS=off, from before 4.4,
#                 still means off.
#   DOMAIN        the public name, for letsencrypt. ACME_EMAIL gets expiry notices (optional).
#   BACKEND_HOST  where the backend is (default backend), BACKEND_PORT its port (default 3000),
#                 for Kubernetes, Podman and split hosts (#436).
set -u

fail() { echo "$0: $*" >&2; exit 1; }
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

MODE=$(lower "${TLS_MODE:-}")
if [ -z "$MODE" ]; then
  case "$(lower "${NGINX_TLS:-}")" in
    off|false|0|no) MODE=off ;;
    *) MODE=self-signed ;;
  esac
fi

# The values land inside Caddyfile syntax, so anything that could not be a hostname or port is
# refused rather than passed on.
HOST=${BACKEND_HOST:-backend}
PORT=${BACKEND_PORT:-3000}
case "$HOST" in *[!A-Za-z0-9._-]*|'') fail "BACKEND_HOST '$HOST' is not a plain hostname or IPv4 address" ;; esac
case "$PORT" in *[!0-9]*|'') fail "BACKEND_PORT '$PORT' is not a port number" ;; esac
export MAILFLOW_BACKEND="$HOST:$PORT"

case "$MODE" in
  off)
    export MAILFLOW_SITES=off
    echo "$0: HTTP on port 80 only (TLS_MODE=off)" ;;

  letsencrypt)
    DOMAIN=${DOMAIN:-}
    # A name with at least one dot, made of hostname characters only.
    case "$DOMAIN" in
      *[!A-Za-z0-9.-]*|.*|*.|*..*) bad=1 ;;
      *.*) bad= ;;
      *) bad=1 ;;
    esac
    [ -n "$bad" ] && fail "TLS_MODE=letsencrypt needs DOMAIN set to this server's public name, got '$DOMAIN'"
    [ "$DOMAIN" = mail.yourdomain.com ] && fail "DOMAIN is still the example value; set it to this server's public name"
    export DOMAIN
    case "${ACME_EMAIL:-}" in
      '') export MAILFLOW_SITES=letsencrypt-no-email ;;
      you@yourdomain.com) export MAILFLOW_SITES=letsencrypt-no-email; echo "$0: ACME_EMAIL is the example value; requesting the certificate without one" ;;
      *[!A-Za-z0-9.@+_-]*|*@*@*) fail "ACME_EMAIL '${ACME_EMAIL}' is not an email address" ;;
      *@*) export MAILFLOW_SITES=letsencrypt ;;
      *) fail "ACME_EMAIL '${ACME_EMAIL}' is not an email address" ;;
    esac
    echo "$0: HTTPS for $DOMAIN with a Let's Encrypt certificate (TLS_MODE=letsencrypt)" ;;

  self-signed)
    export MAILFLOW_SITES=self-signed
    # Installs from before 4.4 mount ./certs at nginx's path; the same files are used either way.
    DIR=/etc/mailflow/certs
    [ -d /etc/nginx/ssl ] && DIR=/etc/nginx/ssl
    if [ ! -f "$DIR/cert.pem" ] || [ ! -f "$DIR/key.pem" ]; then
      echo "$0: no certificate in $DIR; generating a self-signed one"
      if ! openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
          -subj "/C=US/ST=Local/L=Local/O=MailFlow/CN=localhost" \
          -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1; then
        # A read-only filesystem: one made for this start only, so HTTPS still comes up.
        DIR=/tmp/mailflow-certs
        mkdir -p "$DIR" && openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
          -subj "/C=US/ST=Local/L=Local/O=MailFlow/CN=localhost" \
          -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 \
          || fail "cannot write a certificate; mount cert.pem and key.pem at /etc/mailflow/certs, or set TLS_MODE=off"
        echo "$0: the certificate directory is read-only; using a certificate made for this start only (mount cert.pem and key.pem to keep one)"
      fi
    fi
    export MAILFLOW_CERT="$DIR/cert.pem" MAILFLOW_KEY="$DIR/key.pem"
    echo "$0: HTTPS on port 443 with $MAILFLOW_CERT, and HTTP on port 80" ;;

  *) fail "TLS_MODE '$MODE' is not self-signed, letsencrypt or off" ;;
esac

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
