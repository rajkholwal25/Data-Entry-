FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Chromium + libraries required by Puppeteer for FG label rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-crosextra-carlito \
    fonts-noto-color-emoji \
    fontconfig \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    cups-client \
    poppler-utils \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Optional: place Microsoft Calibri .ttf files in fonts/ before build (see fonts/README.md)
RUN mkdir -p /usr/share/fonts/truetype/calibri-custom && \
    if ls /app/fonts/*.ttf >/dev/null 2>&1; then \
      cp /app/fonts/*.ttf /usr/share/fonts/truetype/calibri-custom/ && \
      echo "Installed Calibri font files from fonts/"; \
    fi && \
    fc-cache -f

RUN chmod +x /app/deploy/docker-entrypoint.sh && \
    useradd --create-home --shell /bin/bash appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 4000

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
