# Bandai + Pokémon Centre stock monitor.
# PKC edge matches checkout: chrome_131 tls-worker (DataDome) + Hyper.
# Build context = executor/ (Railway Root Directory).
FROM node:20-bookworm-slim
WORKDIR /app

# Writable TMPDIR for baked tls-client .so seed (node-tls-client reads os.tmpdir()).
RUN mkdir -p /app/.tmp /app/vendor /app/adapters /data \
  && chmod 1777 /app/.tmp
ENV TMPDIR=/app/.tmp

# Install deps at /app so ../monitor/http-undici.js can resolve undici,
# PKC edge can resolve hyper-sdk-js, and tls-worker can load node-tls-client.
COPY monitor-host/package.json monitor-host/package-lock.json ./
RUN npm install --omit=dev

COPY monitor ./monitor
# Bake every runtime module — missing one (e.g. preset-catalog.mjs) crashes boot.
COPY monitor-host/server.js \
     monitor-host/*.mjs \
     ./monitor-host/
COPY monitor-host/admin ./monitor-host/admin

# PKC poller imports executor-root modules (not under monitor/). Without these,
# `import "../monitor/pokemoncentre-stock-monitor.js"` fails at boot → Railway
# healthcheck never passes and deploys stall/rollback.
COPY http.js \
     antibot.js \
     ip-resolve.js \
     ensure-tls-native.js \
     tls-bridge.js \
     tls-worker.js \
     pay-forensics.js \
     ./
COPY adapters/pokemoncentre-session.js \
     adapters/pokemoncentre-edge.js \
     adapters/pokemoncentre-cortex.js \
     ./adapters/

# Bake bogdanfinn tls-client linux-x64 .so (same pin as executor Dockerfile).
# api.github.com downloads from node-tls-client often 403 → process.exit(1).
ARG TLS_CLIENT_SO_VERSION=1.15.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL \
    "https://github.com/bogdanfinn/tls-client/releases/download/v${TLS_CLIENT_SO_VERSION}/tls-client-linux-ubuntu-amd64-${TLS_CLIENT_SO_VERSION}.so" \
    -o /app/vendor/tls-client-x64.so \
  && cp /app/vendor/tls-client-x64.so /app/.tmp/tls-client-x64.so \
  && chmod 755 /app/vendor/tls-client-x64.so /app/.tmp/tls-client-x64.so \
  && test -s /app/vendor/tls-client-x64.so \
  && rm -rf /var/lib/apt/lists/*

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV PORT=8080
ENV NODE_ENV=production
# PKC monitor defaults to checkout transport (override with PC_MONITOR_TLS_WORKER=0).
ENV PC_MONITOR_TLS_WORKER=1
EXPOSE 8080
CMD ["node", "monitor-host/server.js"]
