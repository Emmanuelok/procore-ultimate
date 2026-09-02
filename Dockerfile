# ConstructOS production image — API + same-origin SPA in one container.
# Build:  docker build -t constructos .
# Run:    docker run -p 4000:4000 -e AUTH_SECRET=... -e DATABASE_URL=... constructos

# ---------- build stage ----------
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Self-contained production bundle for the API (workspace deps resolved,
# dev dependencies pruned).
RUN pnpm --filter @constructos/api --prod deploy --legacy /out/api

# ---------- runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out/api ./
COPY --from=build /repo/packages/db/drizzle ./migrations
COPY --from=build /repo/apps/web/dist ./public

# Writable data dir for the embedded-DB / local-storage fallback modes.
# Production on Railway should set DATABASE_URL and STORAGE_DRIVER=s3, in
# which case nothing is ever written here.
RUN mkdir -p /data && chown node:node /data

ENV PORT=4000 \
    HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/migrations \
    WEB_DIST_DIR=/app/public \
    TRUST_PROXY=true \
    STORAGE_DIR=/data/storage \
    PGLITE_DIR=/data/pglite

# The app never needs root. If you mount a Railway volume for the local
# storage driver, set RAILWAY_RUN_UID=0 on the service (Railway mounts
# volumes as root) or use STORAGE_DRIVER=s3 (recommended) which needs no
# volume at all.
USER node

EXPOSE 4000
CMD ["node", "dist/index.js"]
