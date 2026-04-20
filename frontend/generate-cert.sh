#!/bin/sh
# Auto-generates a self-signed TLS certificate if none is present.
# Runs automatically at container startup via /docker-entrypoint.d/
# If you supply your own cert.pem + key.pem in ./certs/, this is skipped.

CERT=/etc/nginx/ssl/cert.pem
KEY=/etc/nginx/ssl/key.pem

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  exit 0
fi

echo "No TLS certificate found — generating self-signed cert..."
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$KEY" \
  -out "$CERT" \
  -subj "/C=US/ST=Local/L=Local/O=MailFlow/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" 2>/dev/null
echo "Self-signed certificate generated."
