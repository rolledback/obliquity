// Pre-compress the built text assets so the server can ship them at maximum compression
// without spending CPU per request. Produces a .gz (gzip level 9) and a .br (brotli quality
// 11) next to every compressible file in dist/. nginx serves the .gz via gzip_static; the
// .br files are ready for any host/CDN that supports brotli_static. Uses only Node's built-in
// zlib, so there is no extra dependency to install.

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const DIST = 'dist';
// Already-compressed binary formats (jpg/png/woff2/...) gain nothing from gzip/brotli, so we
// only pre-compress text-like payloads.
const COMPRESSIBLE = /\.(html|css|js|mjs|json|svg|xml|txt|map|wasm|webmanifest)$/i;
const MIN_BYTES = 1024; // below this the compression overhead is not worth a second request

if (!existsSync(DIST)) {
  console.error(`compress: "${DIST}" not found - run the Vite build first.`);
  process.exit(0);
}

let files = 0;
let rawTotal = 0;
let gzTotal = 0;
let brTotal = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!COMPRESSIBLE.test(name) || stat.size < MIN_BYTES) continue;

    const buf = readFileSync(path);
    const gz = gzipSync(buf, { level: 9 });
    const br = brotliCompressSync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    writeFileSync(`${path}.gz`, gz);
    writeFileSync(`${path}.br`, br);

    files++;
    rawTotal += buf.length;
    gzTotal += gz.length;
    brTotal += br.length;
    const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
    console.log(`  ${path}: ${kb(buf.length)} -> gz ${kb(gz.length)} / br ${kb(br.length)}`);
  }
}

walk(DIST);

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(
  `compress: ${files} files | raw ${kb(rawTotal)} -> gzip ${kb(gzTotal)} (level 9) / brotli ${kb(brTotal)} (q11)`,
);
