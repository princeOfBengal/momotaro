#!/usr/bin/env bash
#
# Build + deploy the Momotaro Linux AppImage into the server's self-hosted
# download directory, so it is served at /downloads/momotaro.AppImage and
# advertised by GET /api/app/version?platform=linux.
#
# MUST run on Linux (or inside a Linux container). AppImage assembly needs
# Linux-only tools (appimagetool / mksquashfs) — it cannot be produced on
# Windows or macOS. From Windows/macOS, run this inside the official builder
# image instead:
#
#   docker run --rm -v "$PWD":/project -w /project \
#     electronuserland/builder:wine bash scripts/deploy-linux-appimage.sh
#
# Version is taken from client/src/version.js (APP_VERSION) — the single source
# of truth the in-app update check compares against.
#
# Env:
#   DATA_PATH   server data dir (default ./data) — AppImage lands in $DATA_PATH/downloads
#   SKIP_BUILD  set to 1 to skip the build and just (re)deploy an existing AppImage
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: AppImage assembly requires Linux. On Windows/macOS use the Docker" >&2
  echo "       command in this script's header (electronuserland/builder)." >&2
  exit 1
fi

VERSION="$(sed -nE "s/.*APP_VERSION *= *'([^']+)'.*/\1/p" client/src/version.js)"
if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not read APP_VERSION from client/src/version.js" >&2
  exit 1
fi
echo "==> Deploying Momotaro Linux AppImage v${VERSION}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building web assets"
  ( cd client && npm ci && npm run build && npx cap sync @capacitor-community/electron )

  echo "==> Building Electron main + AppImage"
  ( cd client/electron && npm ci && npm run build \
      && ./node_modules/.bin/electron-builder --linux AppImage \
           -c ./electron-builder.config.json -p never )
fi

APPIMAGE="$(ls -1t client/electron/dist-electron/*.AppImage 2>/dev/null | head -1 || true)"
if [[ -z "${APPIMAGE}" ]]; then
  echo "ERROR: no .AppImage found in client/electron/dist-electron/ — check the build output." >&2
  exit 1
fi

DEST="${DATA_PATH:-./data}/downloads"
mkdir -p "${DEST}"
cp -f "${APPIMAGE}" "${DEST}/momotaro.AppImage"
cat > "${DEST}/version-linux.json" <<EOF
{
  "version": "${VERSION}",
  "released_at": "$(date +%F)",
  "notes": "Momotaro desktop ${VERSION}."
}
EOF

SIZE="$(du -h "${DEST}/momotaro.AppImage" | cut -f1)"
echo ""
echo "==> Deployed:"
echo "      ${DEST}/momotaro.AppImage   (${SIZE}, from ${APPIMAGE##*/})"
echo "      ${DEST}/version-linux.json  (v${VERSION})"
echo ""
echo "    Served at:     /downloads/momotaro.AppImage"
echo "    Advertised at: /api/app/version?platform=linux"
echo "    Existing desktop installs will see the update banner on next launch."
