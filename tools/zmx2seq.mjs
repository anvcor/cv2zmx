#!/usr/bin/env node
// Command line front end of web/zmx2seq.js: convert Zemax .zmx files to CODE V .seq.
//
//   node tools/zmx2seq.mjs lens.zmx [more.zmx ...] [-o out.seq | -d outdir] [options]
//
// Options (same as the web page):
//   --glass FILE        glass map (default: CV2ZMX_GLASS.DAT next to this repository's macro)
//   --sd aperture|fixed|all   which semi-diameters become CIR (default fixed)
//   --offset base|model       Zemax offset glass → base catalog glass / model glass (default base)
//   --unknown model|guess     glass missing from the map → model glass / guessed name (default model)
//   --no-oal            write position solves as plain thicknesses
//   --no-vars           do not mark MCE thickness variables as ZOO THC 0
//   --keep-wave-order   keep the Zemax wavelength order (default: descending, as CODE V writes it)
//   --keep-field-order  keep the Zemax field order (default: on-axis field first, as CODE V writes it)
//   --encoding gbk|utf-8      output encoding when the text is not pure ASCII (default gbk)
//   --no-comments       no header comments

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertBytes, parseGlassTable, encodeText, ConversionError } from '../web/zmx2seq.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const inputs = [];
const opt = { encoding: 'gbk' };
let out = null, outDir = null, glassPath = join(here, '..', 'CV2ZMX_GLASS.DAT');

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) { console.error(`${a} needs a value`); process.exit(2); }
    return args[++i];
  };
  switch (a) {
    case '-o': out = next(); break;
    case '-d': outDir = next(); break;
    case '--glass': glassPath = next(); break;
    case '--sd': opt.sd = next(); break;
    case '--offset': opt.offsetGlass = next(); break;
    case '--unknown': opt.unknownGlass = next(); break;
    case '--no-oal': opt.oal = false; break;
    case '--no-vars': opt.zoomVars = false; break;
    case '--keep-wave-order': opt.waveOrder = 'keep'; break;
    case '--keep-field-order': opt.fieldOrder = 'keep'; break;
    case '--encoding': opt.encoding = next(); break;
    case '--no-comments': opt.comments = false; break;
    case '-h': case '--help':
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
      break;
    default:
      if (a.startsWith('-')) { console.error(`unknown option ${a}`); process.exit(2); }
      inputs.push(a);
  }
}
if (!inputs.length) { console.error('usage: node tools/zmx2seq.mjs lens.zmx [-o out.seq] (see --help)'); process.exit(2); }
if (out && inputs.length > 1) { console.error('-o takes a single input; use -d for several'); process.exit(2); }

if (existsSync(glassPath)) opt.glassTable = parseGlassTable(readFileSync(glassPath, 'latin1'));
else console.warn(`! glass map not found: ${glassPath} (catalog glasses become model glasses)`);

let failed = 0;
for (const inp of inputs) {
  const target = out || join(outDir || dirname(inp), basename(inp).replace(/\.zmx$/i, '') + '.seq');
  try {
    const res = convertBytes(readFileSync(inp), { ...opt, fileName: basename(inp) });
    writeFileSync(target, encodeText(res.seq, opt.encoding));
    const I = res.info;
    console.log(`${inp} -> ${resolve(target)}`);
    console.log(`  ${I.surfaces} surfaces, ${I.fields} fields, ${I.wavelengths} wavelengths, ${I.configurations} configuration(s), aperture ${I.aperture.key}`);
    for (const p of I.paraxial) {
      console.log(`  Z${p.cfg}${p.title ? ' ' + p.title : ''}: EFL ${p.efl.toFixed(4)}  BFL ${p.bfl.toFixed(4)}${p.finite ? '  mag ' + p.beta.toFixed(5) : ''}  ${p.apertureKey} ${p.aperture.toFixed(6)}`);
    }
    for (const w of res.warnings) console.log(`  ${w.level === 'warn' ? '!' : '-'} ${w.en}`);
  } catch (e) {
    failed++;
    console.error(`${inp}: ${e instanceof ConversionError ? e.en : e.stack}`);
  }
}
process.exit(failed ? 1 : 0);
