#!/bin/sh
set -eu

IMAGE="${IMAGE:-teampat/tunetube:latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-tunetube-multi}"

cd "$(dirname "$0")"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create \
    --name "$BUILDER" \
    --driver docker-container \
    --platform "$PLATFORMS" \
    --bootstrap
fi

docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  -t "$IMAGE" \
  --push \
  .

echo "Pushed $IMAGE ($PLATFORMS)"
