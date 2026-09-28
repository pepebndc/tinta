#!/usr/bin/env bash
# Build the launch videos: the soundtrack, the landscape cut, and the vertical cut.
# Usage: ./build.sh [landscape|vertical|all]   (default: all)
set -euo pipefail
cd "$(dirname "$0")"

target="${1:-all}"
workers="${WORKERS:-4}"

[ -d node_modules ] || npm ci

node music.mjs

# Add the soundtrack to a rendered picture and encode the file for posting.
encode() {
  ffmpeg -loglevel error -y -i "$1" -i music.wav -map 0:v -map 1:a \
    -c:v libx264 -preset slow -crf 19 -maxrate 14M -bufsize 28M -pix_fmt yuv420p \
    -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
    -af "loudnorm=I=-14:TP=-1:LRA=11" -c:a aac -b:a 256k -ar 48000 -t 38 \
    -movflags +faststart "$2"
  echo "wrote $2"
}

if [ "$target" = landscape ] || [ "$target" = all ]; then
  node render.mjs video "$workers"
  encode video.mp4 tinta-launch.mp4
fi
if [ "$target" = vertical ] || [ "$target" = all ]; then
  VERT=1 node render.mjs video "$workers"
  encode video-vertical.mp4 tinta-launch-vertical.mp4
fi
