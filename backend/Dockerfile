FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app

ARG BUILD_SHA
ARG APP_VERSION
ENV BUILD_SHA=${BUILD_SHA:-dev}

COPY --from=deps /app/node_modules ./node_modules
COPY . /repo
RUN apk add --no-cache --virtual .build-deps git && \
    cp /repo/backend/package.json ./package.json && \
    cp -R /repo/backend/src ./src && \
    cp -R /repo/backend/migrations ./migrations && \
    APP_VERSION_VALUE="$APP_VERSION"; \
    if [ -z "$APP_VERSION_VALUE" ]; then \
      APP_VERSION_VALUE="$(git -C /repo describe --tags --abbrev=0 2>/dev/null | sed 's/^v[.]//' | sed 's/^v//' || true)"; \
    fi; \
    if [ -z "$APP_VERSION_VALUE" ]; then \
      APP_VERSION_VALUE="$(node -p "require('./package.json').version")"; \
    fi; \
    APP_VERSION_VALUE="$(printf '%s' "$APP_VERSION_VALUE" | sed 's/^v[.]//' | sed 's/^v//')"; \
    printf '{"version":"%s"}\n' "$APP_VERSION_VALUE" > ./build-meta.json && \
    chown -R node:node /app && \
    rm -rf /repo && \
    apk del .build-deps

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
