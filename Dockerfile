FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg

FROM node:22-bookworm-slim

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

ENV DEBIAN_FRONTEND=noninteractive

# Debian HTTP (port 80) often times out on VPS/CDN. Use HTTPS and retry.
RUN set -eux; \
  find /etc/apt -type f \( -name "*.list" -o -name "*.sources" \) -exec \
    sed -i \
      -e "s|http://deb.debian.org|https://deb.debian.org|g" \
      -e "s|http://security.debian.org|https://deb.debian.org|g" \
      {} +; \
  printf '%s\n' \
    'Acquire::Retries "5";' \
    'Acquire::https::Timeout "20";' \
    'Acquire::http::Timeout "20";' \
    'Acquire::ForceIPv4 "true";' \
    > /etc/apt/apt.conf.d/99-retries; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3; \
  curl -fsSL -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp; \
  chmod a+rx /usr/local/bin/yt-dlp /usr/local/bin/ffmpeg /usr/local/bin/ffprobe; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY server.js ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
  && mkdir -p cache \
  && touch cookies.txt \
  && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV PORT=3000
ENV YTDLP_COOKIES=/app/cookies.txt
ENV YTDLP_COOKIES_FROM_BROWSER=none

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
