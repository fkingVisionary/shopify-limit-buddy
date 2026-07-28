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

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "monitor-host/server.js"]
