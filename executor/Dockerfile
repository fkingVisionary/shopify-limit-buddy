# node-tls-client ships a glibc-built Go shared library — Alpine/musl will
# refuse to load it, so we must use a glibc base image. Playwright's official
# jammy image already includes Chromium + all system libs Playwright needs,
# so we use it as the base for the executor. Node 20 is preinstalled.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy
WORKDIR /app
RUN mkdir -p /app/.tmp && chmod 1777 /app/.tmp
ENV TMPDIR=/app/.tmp
# Hyper's Playwright lane prefers channel:"chrome" (real Google Chrome). The
# base image only ships bundled Chromium — without this, kmart-playwright falls
# back and Akamai often edge-denies before Bot Manager loads (kmart-mriyj1y1).
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
# Playwright browsers are already installed in the base image; skip re-download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev
COPY . .
# Bake git tip into /health so Lovable/desktop can detect Fly↔git deploy drift
# (Jul 17: Fly stayed on ef84707+monitor after main hard-reset to a1d9f9c).
ARG GIT_SHA=unknown
ENV EXECUTOR_GIT_SHA=$GIT_SHA
# Bake bogdanfinn tls-client linux-x64 .so into the image.
# node-tls-client downloads via api.github.com at first initTLS(); that often
# 403s on Fly, then the package process.exit(1)s — which killed tls-worker and
# forced undici (Akamai _abck plateau). Direct release-asset URLs are reliable.
# Pin version; bump when upgrading node-tls-client's expected native ABI.
ARG TLS_CLIENT_SO_VERSION=1.15.1
RUN mkdir -p /app/vendor /app/.tmp \
  && curl -fsSL \
    "https://github.com/bogdanfinn/tls-client/releases/download/v${TLS_CLIENT_SO_VERSION}/tls-client-linux-ubuntu-amd64-${TLS_CLIENT_SO_VERSION}.so" \
    -o /app/vendor/tls-client-x64.so \
  && cp /app/vendor/tls-client-x64.so /app/.tmp/tls-client-x64.so \
  && chmod 755 /app/vendor/tls-client-x64.so /app/.tmp/tls-client-x64.so \
  && test -s /app/vendor/tls-client-x64.so
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
