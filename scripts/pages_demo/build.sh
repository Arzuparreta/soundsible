#!/usr/bin/env bash
# Run after npm ci in ui_web. The target must be a new directory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ui="$here/../../ui_web"
out=$(realpath -m "${1:?supply a new output directory}")
mkdir "$out"
(cd "$ui" && node "$here/build.mjs" "$out")
find "$out" -type f \( -name "*.br" -o -name "*.gz" \) -delete
mv "$out/index.html" "$out/player.html"
sed -i 's|</head>|<link rel="stylesheet" href="./demo.css"></head>|;s|/player/icons/icon-192.png|./icons/icon-192.png|' "$out/player.html"
cp "$here"/{index.html,demo.css} "$out/"
python3 "$here/prepare.py" "$out"
