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
RUN node --input-type=module <<'NODE'
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = process.env.TMPDIR || os.tmpdir();
const platform = process.platform;
const arch = process.arch;
const names = {
  'linux:x64': ['tls-client-x64.so', 'tls-client-linux-ubuntu-amd64-{version}.so'],
  'linux:arm64': ['tls-client-arm64.so', 'tls-client-linux-arm64-{version}.so'],
  'linux:default': ['tls-client-amd64.so', 'tls-client-linux-ubuntu-amd64-{version}.so'],
};
const [fileName, assetTemplate] = names[`${platform}:${arch}`] ?? names[`${platform}:default`] ?? names['linux:default'];
const target = path.join(tmp, fileName);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'j1ms-bot-executor-build' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'j1ms-bot-executor-build' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let lastError;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    const latest = await getJson('https://api.github.com/repos/bogdanfinn/tls-client/releases/latest');
    const version = String(latest.tag_name ?? '').replace(/^v/, '');
    const assetName = assetTemplate.replace('{version}', version);
    const asset = latest.assets?.find((item) => item.name === assetName);
    if (!asset?.browser_download_url) throw new Error(`asset not found: ${assetName}`);
    const body = await download(asset.browser_download_url);
    await writeFile(target, body);
    await chmod(target, 0o755);
    console.log(`prewarmed ${fileName} (${body.length} bytes)`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`tls-client prewarm attempt ${attempt} failed: ${error?.message ?? error}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
}
throw lastError;
NODE
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
