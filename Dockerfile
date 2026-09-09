# ParaDOCs runs as a single image: the API serves the built SPA and the
# collaboration websocket, so a deployment is this container plus Postgres.

# --- install everything needed to build ------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# The desktop app is not part of the server image, but npm ci refuses to run
# unless every workspace in the lockfile is present. Copying its manifest and
# then excluding it from the install keeps Electron out of the build.
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --workspace=@paradocs/api --workspace=@paradocs/web --include-workspace-root

# --- build the web client --------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN npm run build --workspace=@paradocs/web

# --- runtime dependencies only ---------------------------------------------
# A separate install without devDependencies keeps Vite, React and the editor
# toolchain out of the shipped image; the API still needs tsx, which is why it
# is a dependency rather than a dev tool.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev --workspace=@paradocs/api --include-workspace-root

# --- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=4000 \
    UPLOAD_DIR=/data/uploads

# tini reaps zombies and forwards signals, so the graceful shutdown that
# flushes pending collaborative document saves actually runs on `docker stop`.
RUN apk add --no-cache tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Uploads live on a volume. Creating the directory here with the right owner
# means a freshly created named volume inherits that ownership.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node

EXPOSE 4000

# Uses the app's own health route, so the check exercises the real stack.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget --spider -q http://127.0.0.1:4000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
