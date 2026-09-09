#!/bin/sh
set -e

# Migrations are idempotent and tracked in schema_migrations, so running them on
# every boot keeps upgrading to "pull the new image and restart".
# With more than one replica, run this once out of band instead.
echo "ParaDOCs: applying database migrations"
node_modules/.bin/tsx apps/api/src/db/migrate.ts

# exec so the server becomes the process tini signals, rather than a child of a
# shell that would swallow SIGTERM.
echo "ParaDOCs: starting server on port ${API_PORT:-4000}"
exec node_modules/.bin/tsx apps/api/src/server.ts
