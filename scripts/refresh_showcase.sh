#!/bin/sh
# Retake the README and site screenshots, in every theme, and the social card
# built from them (docs/images/screenshots/, docs/images/social-card.png).
#
# Runs in the Playwright image CI uses, so text renders the same whoever runs
# it and a screen that has not changed comes out byte for byte the same file.
# Running `npm run showcase` in ui_web/ directly works too, but this machine's
# font rendering will rewrite every picture.
#
# Afterwards, look at what changed before committing it. The social card also
# has to be uploaded by hand: Settings → Social preview on GitHub. There is no
# API for it.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/ui_web/package-lock.json').packages['node_modules/@playwright/test'].version")"

docker run --rm --ipc host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
  -v "$root:/work" -w /work/ui_web \
  "mcr.microsoft.com/playwright:v$version-noble" \
  sh -c '[ -d node_modules ] || npm ci --no-audit --no-fund; npm run showcase'

git -C "$root" status --short -- docs/images
