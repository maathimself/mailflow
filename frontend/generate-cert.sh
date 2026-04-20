#!/bin/sh
# Generates a self-signed TLS certificate for local HTTPS testing.
# Run this once before starting the stack:
#   sh frontend/generate-cert.sh
# Then start with: docker compose up -d --build
#
# For production, use Caddy with Let's Encrypt instead (--profile https).
mkdir -p certs
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -subj "/C=US/ST=Local/L=Local/O=MailFlow/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
echo "Certificate written to certs/cert.pem and certs/key.pem"
