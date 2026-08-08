# Slim always-on Bandai + Pokémon Centre stock monitor — no Playwright / no tls-client bake.
# Build context = executor/ (Railway Root Directory).
FROM node:20-bookworm-slim
WORKDIR /app

# Install deps at /app so ../monitor/http-undici.js can resolve undici,
# and PKC edge can resolve hyper-sdk-js (antibot.js).
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
     pay-forensics.js \
     ./
COPY adapters/pokemoncentre-session.js \
     adapters/pokemoncentre-edge.js \
     adapters/pokemoncentre-cortex.js \
     ./adapters/

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV PORT=8080
ENV NODE_ENV=production
# Container-writable dir for admin ISP/DC + keywords (survives process restart).
# Attach a Railway volume mounted at /data (or set RAILWAY_VOLUME_MOUNT_PATH) to survive redeploys.
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "monitor-host/server.js"]
