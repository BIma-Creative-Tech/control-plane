# syntax=docker/dockerfile:1
# Control plane — Next.js 16 standalone + worker pg-boss (satu image, dua command).
# Base: ADR 0001 pin `node:24.21.0-bookworm-slim` + digest (index multi-arch, dicek 2026-09-23
# dengan `docker buildx imagetools inspect`).
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# ---- deps: dependency lengkap (dev dibutuhkan untuk build) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

# ---- build: next build (standalone) + bundle worker/migrasi (esbuild) ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: tanpa npm/devDeps, user non-root ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MIGRATIONS_DIR=/app/drizzle

# User non-root khusus (uid/gid 1001), npm/corepack dihapus dari image runtime (tidak dipakai).
RUN groupadd --system --gid 1001 nextjs \
 && useradd --system --uid 1001 --gid nextjs --no-create-home --shell /usr/sbin/nologin nextjs \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Docs output.md: standalone tidak menyalin public/ dan .next/static → salin manual.
COPY --from=build --chown=root:root /app/.next/standalone ./
COPY --from=build --chown=root:root /app/.next/static ./.next/static
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/drizzle ./drizzle

# File aplikasi milik root (read-only bagi uid 1001); cache Next di tmpfs (compose).
RUN mkdir -p /app/.next/cache && chown nextjs:nextjs /app/.next/cache

USER nextjs:nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Web (default). Worker: `node dist/worker/index.mjs`; migrasi: `node dist/db/migrate.mjs`.
CMD ["node", "server.js"]
