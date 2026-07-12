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
# Pre-provision the native tls-client shared library during image build.
# node-tls-client otherwise downloads this file on the first proxied request;
# if GitHub/rate-limit/CDN access fails, the package calls process.exit(1),
# which looks like an empty Fly 502. Failing the deploy is better than killing
# a live checkout run, and this keeps /run deterministic.
COPY scripts/prewarm-tls.mjs ./scripts/prewarm-tls.mjs
RUN node ./scripts/prewarm-tls.mjs
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
