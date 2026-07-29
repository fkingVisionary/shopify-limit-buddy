# Slim always-on Bandai stock monitor — no Playwright / no tls-client.
# Build context = executor/ (Railway Root Directory).
FROM node:20-bookworm-slim
WORKDIR /app

# Install deps at /app so ../monitor/http-undici.js can resolve undici.
COPY monitor-host/package.json monitor-host/package-lock.json ./
RUN npm install --omit=dev

COPY monitor ./monitor
# Bake every runtime module — missing one (e.g. preset-catalog.mjs) crashes boot.
COPY monitor-host/server.js \
     monitor-host/*.mjs \
     ./monitor-host/
COPY monitor-host/admin ./monitor-host/admin

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "monitor-host/server.js"]
