# Stage 1: Build React client
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

# Build tools required to compile native modules (sharp, better-sqlite3)
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --only=production

COPY server/src/ ./src/

# Copy built React app — server serves it from /app/client/dist
COPY --from=client-builder /app/client/dist /app/client/dist

EXPOSE 3000

ENV PORT=3000 \
    LIBRARY_PATH=/app/library \
    DATA_PATH=/app/data \
    SCAN_ON_STARTUP=true \
    METADATA_FETCH_ENABLED=true \
    REQUEST_DELAY_MS=700

CMD ["node", "src/index.js"]
