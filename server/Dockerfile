FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir 'yt-dlp[default]'

COPY . .

ENV PORT=8787
EXPOSE 8787

CMD ["node", "index.js"]
