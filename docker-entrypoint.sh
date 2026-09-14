#!/bin/sh
set -e

COOKIES="${YTDLP_COOKIES:-/app/cookies/cookies.txt}"

if [ -d "$COOKIES" ]; then
  echo "cookies.txt is a directory. Put a Netscape cookies file at ./cookies/cookies.txt on the host."
  exit 1
fi

if [ ! -s "$COOKIES" ]; then
  echo "Warning: $COOKIES is missing or empty. YouTube may block audio downloads."
fi

exec node server.js
