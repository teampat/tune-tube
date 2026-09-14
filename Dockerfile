# syntax=docker/dockerfile:1

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    YTDLP_COOKIES=/app/cookies.txt \
    YTDLP_COOKIES_FROM_BROWSER=none \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

RUN apk add --no-cache python3 ffmpeg ca-certificates curl
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
RUN mkdir -p cache && chown node:node /app cache

COPY --chown=node:node package.json package-lock.json ./
USER node
RUN --mount=type=cache,target=/home/node/.npm \
  npm ci --omit=dev

COPY --chown=node:node public ./public
COPY --chown=node:node server.js docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && touch cookies.txt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
