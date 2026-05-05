FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src/ ./src/
COPY --chown=node:node migrations/ ./migrations/

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
