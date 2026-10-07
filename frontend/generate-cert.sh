#!/bin/sh
# Auto-generates a self-signed TLS certificate if none is present.
# Runs automatically at container startup via /docker-entrypoint.d/
# If you supply your own cert.pem + key.pem in ./certs/, this is skipped.
# Never exits non-zero: the image's entrypoint runs under `set -e`.

CERT=/etc/nginx/ssl/cert.pem
KEY=/etc/nginx/ssl/key.pem

# HTTPS turned off (#516): 18-set-tls.sh removes the server that would use a certificate.
case "$(printf '%s' "${NGINX_TLS:-on}" | tr 'A-Z' 'a-z')" in
  off|false|0|no)
    echo "NGINX_TLS=off: no TLS certificate needed."
    exit 0 ;;
esac

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  exit 0
fi

echo "No TLS certificate found — generating self-signed cert..."
mkdir -p /etc/nginx/ssl 2>/dev/null
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$KEY" \
  -out "$CERT" \
  -subj "/C=US/ST=Local/L=Local/O=MailFlow/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" 2>/dev/null

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "Self-signed certificate generated."
else
  # Saying "generated" here sent people looking for the problem elsewhere: nginx then stops
  # on the missing file. A read-only filesystem is the usual cause.
  echo "Could not write a certificate to /etc/nginx/ssl (read-only filesystem?)."
  echo "Mount cert.pem and key.pem there, or set NGINX_TLS=off to serve HTTP on port 80 only"
  echo "(which needs a writable /etc/nginx/conf.d)."
fi
exit 0
