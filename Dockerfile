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

# READINESS, not liveness. "The process is up" is not the question an
# orchestrator wants answered before it routes traffic: /api/v1/health/ready
# executes a query against the database and reports the configuration warnings
# that make a deployment smaller than it looks. Written with node's own fetch
# so the image needs neither curl nor wget.
#
# `start-period` covers migrations: the first boot against an empty database
# applies 0000 onward before the server listens, and a healthcheck that fails
# during that window restarts the container mid-migration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3   CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node is PID 1 here and installs its own SIGTERM handler (apps/api/src/index.ts):
# the server stops accepting connections, in-flight requests finish, the
# database pool closes, and a 25-second deadline guarantees the process exits.
# An init shim would only duplicate that, so there is deliberately none.
CMD ["node", "dist/index.js"]
