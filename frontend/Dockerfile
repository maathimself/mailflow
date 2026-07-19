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

FROM nginx:alpine

RUN apk add --no-cache openssl

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/generate-cert.sh /docker-entrypoint.d/10-generate-cert.sh
RUN chmod +x /docker-entrypoint.d/10-generate-cert.sh

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
