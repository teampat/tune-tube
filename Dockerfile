# syntax=docker/dockerfile:1
FROM node:22-alpine

RUN apk add --no-cache python3 ffmpeg ca-certificates
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY --chown=node:node public ./public
COPY --chown=node:node server.js ./
COPY --chmod=755 --chown=node:node docker-entrypoint.sh ./
RUN mkdir -p cache cookies \
  && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV PORT=3000
ENV LANG=C.UTF-8
ENV PYTHONUTF8=1
ENV PYTHONIOENCODING=utf-8
ENV YTDLP_COOKIES=/app/cookies/cookies.txt
ENV YTDLP_COOKIES_FROM_BROWSER=none

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
