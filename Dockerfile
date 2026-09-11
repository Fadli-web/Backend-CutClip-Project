# ==============================================================================
# DOCKERFILE: YOUTUBE VIDEO CLIPPER BACKEND WORKER (RAILWAY COMPATIBLE)
# ==============================================================================

FROM node:22-bookworm-slim

# Pasang dependency sistem: FFmpeg, Python3, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pasang yt-dlp versi binary rilis terbaru langsung dari GitHub
# Menggunakan rilis terbaru sangat penting untuk menjaga kompatibilitas player YouTube
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Direktori kerja aplikasi
WORKDIR /app

# Salin manifest dependensi
COPY package*.json ./

# Pasang dependensi produksi
RUN npm ci --omit=dev

# Salin seluruh kode aplikasi
COPY . .

# Buat folder sementara untuk buffering video
RUN mkdir -p /app/temp && chmod 777 /app/temp

# Environment variables bawaan
ENV NODE_ENV=production
ENV PORT=4000
ENV TEMP_DIR=/app/temp
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 4000

# Jalankan server Express & worker
CMD ["node", "src/index.js"]
