# Slim always-on Bandai stock monitor — no Playwright / no tls-client.
# Build context = executor/ (Railway Root Directory).
FROM node:20-bookworm-slim
WORKDIR /app

# Install deps at /app so ../monitor/http-undici.js can resolve undici.
COPY monitor-host/package.json monitor-host/package-lock.json ./
RUN npm install --omit=dev

COPY monitor ./monitor
COPY monitor-host/server.js ./monitor-host/server.js
COPY monitor-host/vanta-discord.mjs ./monitor-host/vanta-discord.mjs
COPY monitor-host/runtime-config.mjs ./monitor-host/runtime-config.mjs
COPY monitor-host/bot-vault.mjs ./monitor-host/bot-vault.mjs
COPY monitor-host/bot-executor.mjs ./monitor-host/bot-executor.mjs
COPY monitor-host/lab-log.mjs ./monitor-host/lab-log.mjs
COPY monitor-host/admin ./monitor-host/admin

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "monitor-host/server.js"]
