# Overridable Caddy base for hosts whose older kernels cannot exec binaries from the newest
# Alpine package repo (e.g. some NAS units): set FRONTEND_BASE to an older tag such as
# caddy:2.10-alpine.
ARG FRONTEND_BASE=caddy:2-alpine

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
# electron is a devDependency used only for desktop packaging (electron-builder),
# never by the web/vite build. Skip its ~100MB binary download so the multi-arch
# image build (incl. arm64 under QEMU) stays fast and can't fail on a flaky fetch.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

COPY . /repo
RUN cp -R /repo/frontend/. /app/

ARG VITE_BUILD_SHA
ENV VITE_BUILD_SHA=${VITE_BUILD_SHA:-dev}
ARG VITE_EMAIL_DIV_RENDER
ENV VITE_EMAIL_DIV_RENDER=${VITE_EMAIL_DIV_RENDER:-false}

RUN npm run build

FROM ${FRONTEND_BASE}

# openssl makes the self-signed certificate on first start (caddy/start.sh).
RUN apk add --no-cache openssl && mkdir -p /etc/mailflow/certs

COPY --from=builder /app/dist /srv
COPY frontend/caddy/Caddyfile frontend/caddy/sites-*.caddy /etc/caddy/
COPY frontend/caddy/start.sh /usr/local/bin/mailflow-start
RUN chmod +x /usr/local/bin/mailflow-start

EXPOSE 80 443 443/udp

CMD ["/usr/local/bin/mailflow-start"]
