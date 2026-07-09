// Post-build brotli precompression. Runs as part of `npm run build` (see
// package.json) and inside the Docker client-builder stage, which copies
// only client/ — hence this lives here rather than in the repo-root
// scripts/ directory.
//
// Walks dist/ and writes a `.br` sibling for every compressible asset. The
// server (server/src/index.js) serves the sibling to `Accept-Encoding: br`
// clients with the original Content-Type + `Content-Encoding: br`; everything
// else falls through to the plain file and the compression middleware, which
// compresses dynamically per request (brotli quality 4 for br-capable
// clients as of compression@1.8, gzip otherwise). Build-time quality 11
// yields smaller bodies than the dynamic q4 at zero request-time CPU.
//
// Images / fonts are skipped (already compressed), as are files under 1 KiB
// (headers outweigh the savings — mirrors the gzip middleware's threshold).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIST = path.join(__dirname, '..', 'dist');
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.webmanifest', '.json']);
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

if (!fs.existsSync(DIST)) {
  console.error('[precompress] dist/ not found — run vite build first.');
  process.exit(1);
}

let count = 0;
let inBytes = 0;
let outBytes = 0;

for (const file of walk(DIST)) {
  if (file.endsWith('.br')) continue;
  if (!COMPRESSIBLE.has(path.extname(file).toLowerCase())) continue;
  const src = fs.readFileSync(file);
  if (src.length < MIN_BYTES) continue;
  const br = zlib.brotliCompressSync(src, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.length,
    },
  });
  // A .br larger than the source would be pure loss — never observed for
  // text assets, but cheap to guard.
  if (br.length >= src.length) continue;
  fs.writeFileSync(`${file}.br`, br);
  count += 1;
  inBytes += src.length;
  outBytes += br.length;
}

console.log(
  `[precompress] ${count} file(s): ${(inBytes / 1024).toFixed(0)} KiB -> ` +
  `${(outBytes / 1024).toFixed(0)} KiB brotli (${inBytes ? Math.round((1 - outBytes / inBytes) * 100) : 0}% smaller).`
);
