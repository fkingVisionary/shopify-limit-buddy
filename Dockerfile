# Dashboard (TanStack Start control plane) — Railway / Node host.
# Executor stays on Fly.io (see executor/Dockerfile). Do not point this
# service's Root Directory at executor/.
#
# Build emits `.output/` (Nitro node-server). There is no `/app/dist`.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Bake client env at build time (Vite). Pass as Docker build-args / Railway
# Variables marked "Available at Build Time".
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID \
    NITRO_PRESET=node-server

RUN npm run build && test -f .output/server/index.mjs

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0

COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
# Nitro reads PORT / NITRO_PORT (Railway injects PORT).
CMD ["node", ".output/server/index.mjs"]
