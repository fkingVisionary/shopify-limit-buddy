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
# Do not prewarm node-tls-client during image builds. Its native asset endpoint
# can return 403 and fail the whole deploy; the default runtime transport is
# undici, and TLS is opt-in via EXECUTOR_HTTP_TRANSPORT=tls.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
