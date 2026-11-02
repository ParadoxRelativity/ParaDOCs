# The optional presentation converter: LibreOffice Impress behind a small HTTP
# server, turning .ppt, .pps, .pot, Keynote and .odp files into .pptx for
# ParaDOCs Slides, and drawing decks' .emf and .wmf pictures to PNGs. Run by
# the `converter` profile of docker-compose.yml, and not part of the main
# image, so a server without it stays small.
#
#   docker build -t paradoxrelativity/paradocs-converter converter
FROM node:22-slim

# Impress and Draw (which opens metafile pictures) alone, not the whole suite,
# and the fonts decks most often use or have metric-compatible stand-ins for,
# so text wraps as it did in the original. tini runs as process 1, below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini \
    libreoffice-impress \
    libreoffice-draw \
    fonts-liberation \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# No setuid or setgid programs (su, passwd, mount and the like come with the
# base image), so nothing in the container can gain privileges. This does the
# job of `no-new-privileges`, which some hosts will not start a container with.
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} +

COPY server.mjs /app/server.mjs

# Not root. HOME is a writable path because the container's filesystem is
# read-only at run time, with only /tmp writable.
USER node
ENV HOME=/tmp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tini, from the image, reaps whatever LibreOffice leaves behind and passes
# signals on, without depending on the compose file asking for `init: true`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/server.mjs"]
