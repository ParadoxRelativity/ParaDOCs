# The optional presentation converter: LibreOffice Impress behind a small HTTP
# server, turning .ppt, .pps, .pot, Keynote and .odp files into .pptx for
# ParaDOCs Slides. Run by the `converter` profile of docker-compose.yml, and
# not part of the main image, so a server without it stays small.
#
#   docker build -t paradoxrelativity/paradocs-converter converter
FROM node:22-slim

# Impress alone, not the whole suite, and the fonts decks most often use or
# have metric-compatible stand-ins for, so text wraps as it did in the original.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    fonts-liberation \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY server.mjs /app/server.mjs

# Not root. HOME is a writable path because the container's filesystem is
# read-only at run time, with only /tmp writable.
USER node
ENV HOME=/tmp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
