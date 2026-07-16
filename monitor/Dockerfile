FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Prefer vendored impl inside the image (desktop/ not present).
ENV MONITOR_USE_VENDORED=1

ENV PORT=8091
EXPOSE 8091

CMD ["node", "src/server.cjs"]
