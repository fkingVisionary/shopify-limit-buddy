# node-tls-client ships a glibc-built Go shared library — Alpine/musl will
# refuse to load it, so we must use a glibc base image. Playwright's official
# jammy image already includes Chromium + all system libs Playwright needs,
# so we use it as the base for the executor. Node 20 is preinstalled.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy
WORKDIR /app
RUN mkdir -p /app/.tmp && chmod 1777 /app/.tmp
ENV TMPDIR=/app/.tmp
COPY package.json ./
# Playwright browsers are already installed in the base image; skip re-download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev
COPY . .
# Do not prewarm node-tls-client during image builds. Its native asset endpoint
# can return 403 and fail the whole deploy; the default runtime transport is
# undici, and TLS is opt-in via EXECUTOR_HTTP_TRANSPORT=tls.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
