# syntax=docker/dockerfile:1
# Control plane — Next.js 16 standalone + worker pg-boss (satu image, dua command).
# Base: `node:24.22.1-alpine` (Alpine 3.24) + digest index multi-arch, diverifikasi 2026-10-23 via
# Docker Hub API & `docker buildx imagetools inspect`. Revisi ADR 0001 (bookworm-slim → alpine,
# disetujui user; alasan: Trivy HIGH/CRITICAL unfixed jauh lebih sedikit).
ARG NODE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

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
RUN addgroup -S -g 1001 nextjs \
 && adduser -S -D -H -u 1001 -G nextjs -s /sbin/nologin nextjs \
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
