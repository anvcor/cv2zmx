#!/usr/bin/env node
// Command line front end of web/seq2zmx.js: convert CODE V .seq files to Zemax .zmx.
//
//   node tools/seq2zmx.mjs lens.seq [more.seq ...] [-o out.zmx | -d outdir] [--glass FILE]
//
//   --glass FILE   glass map (default: CV2ZMX_GLASS.DAT in this repository)
//
// The .zmx is ASCII, or UTF-16LE with BOM when the title has non-ASCII characters.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlassTable, ConversionError } from '../web/zmx2seq.js';
import { convertSeqBytes, encodeZmx } from '../web/seq2zmx.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const inputs = [];
let out = null, outDir = null, glassPath = join(here, '..', 'CV2ZMX_GLASS.DAT');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '-d') outDir = args[++i];
  else if (a === '--glass') glassPath = args[++i];
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else if (a.startsWith('-')) { console.error(`unknown option ${a}`); process.exit(2); } else inputs.push(a);
}
if (!inputs.length) { console.error('usage: node tools/seq2zmx.mjs lens.seq [-o out.zmx] (see --help)'); process.exit(2); }
if (out && inputs.length > 1) { console.error('-o takes a single input; use -d for several'); process.exit(2); }

const glassTable = existsSync(glassPath) ? parseGlassTable(readFileSync(glassPath, 'latin1')) : null;
if (!glassTable) console.warn(`! glass map not found: ${glassPath}`);

let failed = 0;
for (const inp of inputs) {
  const target = out || join(outDir || dirname(inp), basename(inp).replace(/\.seq$/i, '') + '.zmx');
  try {
    const res = convertSeqBytes(readFileSync(inp), { glassTable, fileName: basename(inp) });
    writeFileSync(target, encodeZmx(res.zmx));
    const I = res.info;
    console.log(`${inp} -> ${resolve(target)}`);
    console.log(`  ${I.surfaces} surfaces, ${I.fields} fields, ${I.wavelengths} wavelengths, ${I.configurations} configuration(s), aperture ${I.aperture.key}, GCAT ${I.gcat.join(' ') || 'SCHOTT'}`);
    for (const p of I.paraxial) console.log(`  Z${p.cfg}: EFL ${p.efl.toFixed(4)}  BFL ${p.bfl.toFixed(4)}${p.finite ? '  mag ' + p.beta.toFixed(5) : ''}`);
    for (const w of res.warnings) console.log(`  ${w.level === 'warn' ? '!' : '-'} ${w.en}`);
  } catch (e) {
    failed++;
    console.error(`${inp}: ${e instanceof ConversionError ? e.en : e.stack}`);
  }
}
process.exit(failed ? 1 : 0);
