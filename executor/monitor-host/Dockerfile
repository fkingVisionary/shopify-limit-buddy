# Slim always-on Bandai stock monitor — no Playwright / no tls-client.
# Build context = executor/ (Railway Root Directory).
FROM node:20-bookworm-slim
WORKDIR /app

COPY monitor-host/package.json ./monitor-host/package.json
WORKDIR /app/monitor-host
RUN npm install --omit=dev

WORKDIR /app
COPY monitor ./monitor
COPY monitor-host/server.js ./monitor-host/server.js

ENV PORT=8080
ENV NODE_ENV=production
WORKDIR /app/monitor-host
EXPOSE 8080
CMD ["node", "server.js"]
