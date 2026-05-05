FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node src/ ./src/
COPY --chown=node:node migrations/ ./migrations/

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
