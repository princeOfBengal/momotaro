# Stage 1: Build React client
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Stage 2: Compile native modules (sharp, better-sqlite3) against target Alpine
FROM node:20-alpine AS server-builder
RUN apk add --no-cache python3 make g++ vips-dev
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# Stage 3: Lean production image
FROM node:20-alpine
# vips is a runtime dependency of sharp
RUN apk add --no-cache vips wget
WORKDIR /app/server
COPY server/src/ ./src/
COPY --from=server-builder /app/server/node_modules ./node_modules
COPY --from=client-builder /app/client/dist /app/client/dist

EXPOSE 3000

ENV PORT=3000 \
    LIBRARY_PATH=/app/library \
    DATA_PATH=/app/data \
    SCAN_ON_STARTUP=true \
    METADATA_FETCH_ENABLED=true \
    REQUEST_DELAY_MS=700

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/index.js"]
