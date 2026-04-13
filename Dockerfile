# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/BUILD_DATE

VOLUME ["/data"]

EXPOSE 3000

ENV CONFIG_PATH=/app/config.yaml

CMD ["node", "dist/scheduler.js"]
