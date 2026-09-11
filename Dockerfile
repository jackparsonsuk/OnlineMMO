# One image containing both halves: the Colyseus server, and the built client
# it serves from its own origin. Same origin means no CORS, no server URL baked
# into the bundle, and one certificate to manage.

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not reinstall the world.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build:shared \
 && npm run build -w @mmo/server \
 && npm run build -w @mmo/client

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only; nothing here needs a compiler.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/client/dist ./packages/client/dist

# The SQLite file lives here. Mount a volume on it or a restart loses every
# character in the realm.
RUN mkdir -p /app/data
ENV DATABASE_FILE=/app/data/ostracon.db
VOLUME ["/app/data"]

# Don't run the server as root — but start as root, because a mounted volume
# arrives owned by root (Fly's always does), and a server that cannot write
# its own database crash-loops at boot. The entrypoint hands the data
# directory to `node` and then drops to it with su-exec before starting.
RUN apk add --no-cache su-exec \
 && printf '#!/bin/sh\nset -e\nchown -R node:node /app/data\nexec su-exec node "$@"\n' > /usr/local/bin/entrypoint \
 && chmod +x /usr/local/bin/entrypoint

EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:2567/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node", "packages/server/dist/index.js"]
