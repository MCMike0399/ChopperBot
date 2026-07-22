# ── Build stage: install deps + compile TypeScript ───────────────────────────
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
# Build tools only in the build stage, so better-sqlite3 can fall back to a
# source build if no prebuilt binary matches (linux/arm64 + glibc has one).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

# ── Runtime stage: compiled output + prod deps only ──────────────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# SQLite lives here (ephemeral on Fargate; bindings re-seed from env on boot).
ENV CHOPPERBOT_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
CMD ["node", "dist/index.js"]
