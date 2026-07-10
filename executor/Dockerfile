# node-tls-client ships a glibc-built Go shared library — Alpine/musl will
# refuse to load it, so we must use a glibc base image.
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/.tmp && chmod 1777 /app/.tmp
ENV TMPDIR=/app/.tmp
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# node-tls-client downloads its native Go shared library on first init into
# os.tmpdir(). Fly can present a fresh runtime /tmp, so keep TMPDIR inside the
# image and prewarm there; otherwise first live checkout can download/fail and
# the package calls process.exit(1), returning an empty 502 for /run.
RUN node -e "import('node-tls-client').then(async ({ initTLS, destroyTLS }) => { await initTLS(); await destroyTLS?.(); })"
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
