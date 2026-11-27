#!/usr/bin/env bash
# Run after npm ci in ui_web. The target must be a new directory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ui="$here/../../ui_web"
out=$(realpath -m "${1:?supply a new output directory}")
mkdir "$out"
(cd "$ui" && ./node_modules/.bin/vite build --base ./ --outDir "$out")
find "$out" -type f \( -name "*.br" -o -name "*.gz" \) -delete
mv "$out/index.html" "$out/player.html"
cp "$here"/{index.html,demo-worker.js,credits.html,cover.svg} "$out/"
python3 "$here/music.py" "$out"
