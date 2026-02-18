# Multi-stage Dockerfile for OmniStream
FROM node:18-alpine AS builder
WORKDIR /usr/src/app

# Install build deps if needed, copy manifests first to leverage cache
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --production --silent; else npm install --production --silent; fi

# Copy app
COPY . .

# Final image
FROM node:18-alpine
WORKDIR /usr/src/app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy app from builder
COPY --from=builder /usr/src/app /usr/src/app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD curl -fsS http://localhost:3000/api/status || exit 1

CMD ["node", "server.js"]
