# node-tls-client ships a glibc-built Go shared library — Alpine/musl will
# refuse to load it, so we must use a glibc base image.
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# node-tls-client downloads its native Go shared library on first init into
# os.tmpdir(). If that first download happens on the live VM and fails, the
# package calls process.exit(1), so Fly returns an empty 502 for /run. Prewarm
# the library into the image at build time so checkout requests never trigger
# that crash path.
RUN node -e "import('node-tls-client').then(async ({ initTLS, destroyTLS }) => { await initTLS(); await destroyTLS?.(); })"
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
