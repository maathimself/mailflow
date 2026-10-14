FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
# This stage runs on the build machine, but sharp's prebuilt image library is native code: install
# the one for the platform being built (an arm64 image built on amd64 needs the arm64 binary).
ARG TARGETARCH
RUN npm ci --omit=dev --os=linux --libc=musl --cpu="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)"

FROM node:22-alpine AS runtime

WORKDIR /app

ARG BUILD_SHA
ARG APP_VERSION
ENV BUILD_SHA=${BUILD_SHA:-dev}

COPY --from=deps /app/node_modules ./node_modules
COPY . /repo
RUN cp /repo/backend/package.json ./package.json && \
    cp -R /repo/backend/src ./src && \
    cp -R /repo/backend/migrations ./migrations && \
    APP_VERSION_VALUE="${APP_VERSION:-$(node -p "require('./package.json').version")}"; \
    APP_VERSION_VALUE="$(printf '%s' "$APP_VERSION_VALUE" | sed 's/^v[.]//' | sed 's/^v//')"; \
    printf '{"version":"%s"}\n' "$APP_VERSION_VALUE" > ./build-meta.json && \
    chown -R node:node /app && \
    rm -rf /repo

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
