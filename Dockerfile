FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
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
