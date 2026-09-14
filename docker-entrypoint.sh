#!/bin/sh
set -e

if [ -d "${YTDLP_COOKIES:-/app/cookies.txt}" ]; then
  echo "cookies.txt is a directory. Create a file named cookies.txt on the host before compose up."
  exit 1
fi

if [ ! -s "${YTDLP_COOKIES:-/app/cookies.txt}" ]; then
  echo "Warning: cookies.txt is missing or empty. YouTube may block audio downloads."
fi

exec node server.js
