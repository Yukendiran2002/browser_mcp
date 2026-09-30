# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────
FROM node:22-slim

# Install Playwright system dependencies for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    fonts-liberation fonts-noto-color-emoji dbus \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Install Playwright browsers (chromium only by default for smaller image)
RUN npx playwright install chromium

COPY --from=builder /app/dist ./dist

# No display in the container: always run headless.
ENV BROWSER_HEADLESS=1

# Default: MCP over stdio. For remote use pass e.g. `--http 8931 --host 0.0.0.0 --token <secret>`.
EXPOSE 8931
ENTRYPOINT ["node", "dist/index.js"]
