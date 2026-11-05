# NODE_IMAGE / NPM_REGISTRY let a network that cannot reach Docker Hub / registry.npmjs.org build through a
# mirror or a Nexus proxy (scripts/publish-images.sh passes them from scripts/.env). Defaults are the public ones.
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=
WORKDIR /app

COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=8181 \
    DATA_DIR=/app/data

# Runs as root (see docker-compose.yml): Docker socket + file manager + host monitoring need it.
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8181

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8181/ >/dev/null || exit 1

CMD ["node", "src/server.js"]
