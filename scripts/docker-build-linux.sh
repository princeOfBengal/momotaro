#!/usr/bin/env bash
#
# In-container build of the Momotaro Linux AppImage, invoked by the Docker
# command in BUILD_LINUX.md (electronuserland/builder image). Runs entirely on
# Linux. Expects:
#   /project  → repo bind-mount (with client/node_modules + client/electron/node_modules
#               shadowed by anonymous volumes so host Windows modules aren't touched)
#   /out      → host data/downloads bind-mount (where the AppImage is deployed)
#
# electron-builder output goes to container-local /tmp so the symlink-heavy
# AppImage assembly never touches the (Windows) bind mount.
set -euo pipefail

echo "==> node $(node -v) / npm $(npm -v)"

echo "==> client: install + web build + cap sync"
cd /project/client
npm ci
npm run build
npx cap sync @capacitor-community/electron

echo "==> electron: install + tsc"
cd /project/client/electron
npm ci
./node_modules/.bin/tsc

echo "==> electron-builder: Linux AppImage"
./node_modules/.bin/electron-builder --linux AppImage \
  -c ./electron-builder.config.json -p never \
  --config.directories.output=/tmp/dist-electron

echo "==> deploy to /out"
mkdir -p /out
cp -f /tmp/dist-electron/*.AppImage /out/momotaro.AppImage
VER="$(sed -nE "s/.*APP_VERSION *= *'([^']+)'.*/\1/p" /project/client/src/version.js)"
printf '{\n  "version": "%s",\n  "released_at": "%s",\n  "notes": "Momotaro desktop %s."\n}\n' \
  "$VER" "$(date +%F)" "$VER" > /out/version-linux.json

ls -la /out
echo "CONTAINER_BUILD_DONE v${VER}"
