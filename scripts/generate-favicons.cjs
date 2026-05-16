// One-shot favicon / PWA-icon / navbar-logo generator.
//
// Run from the repo root with `node scripts/generate-favicons.cjs`. Two
// sources of truth, both in assets/:
//
//   - icon-only.png — square chibi on a rounded peach background, with
//     white pixels in the corners outside the rounded shape. Used for
//     everything except the navbar wordmark. This script flood-fills
//     the white border to transparent before resizing, so the rounded
//     icon shape is preserved with transparent corners — small enough
//     to look right at every density and the Android launcher mask can
//     do whatever it wants with the alpha edges.
//
//   - new_logo.png — landscape "Momotaro 桃太郎" wordmark. Used as
//     /logo.png in the navbar + pairing wizard. Resized preserving
//     aspect ratio (navbar height is 40px → 256px-tall source is
//     plenty for hi-DPI).
//
// All outputs land in client/public/ at the exact filenames the SPA's
// index.html + VitePWA manifest reference. Idempotent.

const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '..', 'server', 'node_modules', 'sharp'));

const ICON_SRC = path.join(__dirname, '..', 'assets', 'icon-only.png');
const LOGO_SRC = path.join(__dirname, '..', 'assets', 'new_logo.png');
const OUT      = path.join(__dirname, '..', 'client', 'public');

/**
 * Flood-fill from each corner of an RGBA image, marking every connected
 * near-white pixel as transparent. Stops at the first non-white pixel,
 * so white pixels inside the subject (e.g. the character's teeth or eye
 * highlights) are preserved — only the contiguous white border that
 * frames the rounded peach shape is removed. Operates in-place on `data`.
 */
function floodFillCornersToTransparent(data, width, height, channels = 4, threshold = 240) {
  const isWhite = (i) => data[i] > threshold && data[i + 1] > threshold && data[i + 2] > threshold;
  const visited = new Uint8Array(width * height);
  const stack = [];

  const seed = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const ni = y * width + x;
    if (visited[ni]) return;
    const di = ni * channels;
    if (!isWhite(di)) return;
    visited[ni] = 1;
    stack.push(x, y);
  };

  seed(0, 0);
  seed(width - 1, 0);
  seed(0, height - 1);
  seed(width - 1, height - 1);

  while (stack.length > 0) {
    const y = stack.pop();
    const x = stack.pop();
    const i = (y * width + x) * channels;
    data[i + 3] = 0;
    seed(x - 1, y);
    seed(x + 1, y);
    seed(x, y - 1);
    seed(x, y + 1);
  }
}

async function loadTrimmedIcon() {
  const { data, info } = await sharp(ICON_SRC)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  floodFillCornersToTransparent(data, info.width, info.height, info.channels);
  // Return a sharp instance we can resize off — composed from the in-memory
  // raw buffer rather than a temp file on disk.
  return { data, info };
}

function trimmedIconAt(size, raw) {
  return sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
    .resize(size, size, { fit: 'cover' })
    .png();
}

(async () => {
  console.log('Trimming white border from icon-only.png…');
  const raw = await loadTrimmedIcon();

  // Persist the trimmed icon back to disk so @capacitor/assets (which
  // reads assets/icon-only.png directly) generates Android launcher
  // icons from the trimmed version too.
  await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
    .png()
    .toFile(ICON_SRC);
  console.log(`  Overwrote ${path.relative(process.cwd(), ICON_SRC)} with transparent-corner version.`);

  console.log('Generating PWA + favicon PNGs:');
  const ICON_TARGETS = [
    { name: 'icon-192.png',         size: 192 },
    { name: 'icon-512.png',         size: 512 },
    { name: 'apple-touch-icon.png', size: 180 },
    { name: 'favicon.png',          size: 32  },
  ];
  for (const { name, size } of ICON_TARGETS) {
    const dst = path.join(OUT, name);
    await trimmedIconAt(size, raw).toFile(dst);
    const bytes = fs.statSync(dst).size;
    console.log(`  ${name.padEnd(24)} ${size}x${size}  ${(bytes / 1024).toFixed(1)} KB`);
  }

  console.log('Generating navbar logo from new_logo.png:');
  const LOGO_HEIGHT = 256;
  const logoDst = path.join(OUT, 'logo.png');
  await sharp(LOGO_SRC).resize({ height: LOGO_HEIGHT }).png().toFile(logoDst);
  const logoBytes = fs.statSync(logoDst).size;
  console.log(`  logo.png                  height=${LOGO_HEIGHT}  ${(logoBytes / 1024).toFixed(1)} KB`);

  console.log('Done.');
})();
