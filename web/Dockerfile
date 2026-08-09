# Next.js practice app. Multi-stage so the runtime image carries no toolchain.
# Build context is the repository root, so `shared/schema.sql` is reachable.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 falls back to node-gyp when no prebuilt binary matches the
# platform, so the build stage (and only the build stage) needs a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY web/package.json web/package-lock.json* ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
# Present at build time so pages that read the database can be traced.
COPY shared ./shared
ENV BEE_SCHEMA_PATH=/app/shared/schema.sql
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BEE_DATA_DIR=/data \
    BEE_DB_PATH=/data/bee.db \
    BEE_INBOX_DIR=/data/inbox \
    BEE_SCHEMA_PATH=/app/shared/schema.sql

RUN useradd --create-home --uid 10001 bee

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# `standalone` traces better-sqlite3's JS but not its prebuilt .node binary.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY shared ./shared

RUN mkdir -p /data /opt/bee && chown -R bee /data /app /opt/bee

# The database baked into the image, built by `crawler seed`.
#
# /opt/bee, never /data — a volume mounted at /data would hide a seed placed
# inside it and the container would come up with nothing. It is copied into
# place on first boot instead, which populates a fresh volume while keeping
# everything written afterwards.
#
# The `data/seed.db*` glob may match nothing; schema.sql is listed alongside it
# only so COPY always has at least one source, which Docker requires. Without
# a seed the build still succeeds and the app simply starts empty.
COPY shared/schema.sql data/seed.db* /opt/bee/staged/
RUN mkdir -p /opt/bee \
    && if [ -f /opt/bee/staged/seed.db ]; then mv /opt/bee/staged/seed.db /opt/bee/seed.db; fi \
    && rm -rf /opt/bee/staged \
    && chown -R bee /opt/bee
ENV BEE_SEED_DB=/opt/bee/seed.db

# Installs the seed before the server starts, so a fresh deployment is
# populated on boot rather than on the first request that happens to read a
# table.
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/bee-entrypoint

USER bee

EXPOSE 3000
ENTRYPOINT ["bee-entrypoint"]
CMD ["node", "server.js"]
