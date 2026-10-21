#!/usr/bin/env node
// Assemble the GitHub Pages site into _site/ (used by .github/workflows/pages.yml and `npm run serve`).
//
//   _site/index.html, app.js, zmx2seq.js, seq2zmx.js, zip.js   ← web/
//   _site/CV2ZMX_GLASS.DAT, CV2ZMX.seq     ← repository root (downloadable from the site as well)

import { cpSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, process.argv[2] || '_site');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of readdirSync(join(root, 'web'))) cpSync(join(root, 'web', f), join(out, f), { recursive: true });
for (const f of ['CV2ZMX_GLASS.DAT', 'CV2ZMX.seq']) cpSync(join(root, f), join(out, f));
writeFileSync(join(out, '.nojekyll'), '');      // serve files as they are
console.log(`site written to ${out}`);
