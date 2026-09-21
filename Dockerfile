# Render / Docker：先複製 Chrome 安裝腳本再 pnpm install，避免 postinstall 找不到檔案。
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libxshmfence1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml ./
COPY scripts/ensure-chromium.mjs ./scripts/ensure-chromium.mjs

RUN pnpm install --no-frozen-lockfile

COPY . .
ENV DG_CHROME_REQUIRE_SMOKE=1
RUN node scripts/ensure-chromium.mjs && pnpm build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["pnpm", "start"]
