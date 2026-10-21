// node --test "test/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertZmx, parseZmx, parseGlassTable, decodeBytes, ConversionError } from '../web/zmx2seq.js';
import { convertSeq, convertSeqBytes, seqCommands, decodeModelGlass, parseSeq, encodeZmx } from '../web/seq2zmx.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => decodeBytes(readFileSync(join(here, 'fixtures', name))).text;
const glassTable = parseGlassTable(readFileSync(join(here, '..', 'CV2ZMX_GLASS.DAT'), 'latin1'));
const opts = { glassTable, date: '2026-10-20T00:00:00Z', fileName: 'test.seq' };
const lines = zmx => zmx.split('\r\n');
const has = (zmx, line) => assert.ok(lines(zmx).includes(line), `missing line: ${line}\n${zmx}`);
const hasNot = (zmx, re) => assert.ok(!re.test(zmx), `unexpected ${re}\n${zmx}`);
const warned = (res, re) => assert.ok(res.warnings.some(w => re.test(w.en)), `no warning matching ${re}: ${JSON.stringify(res.warnings.map(w => w.en))}`);
const close = (a, b, tol = 1e-9) => a === b || Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const surfaceBlock = (zmx, i) => {
  const L = lines(zmx), k = L.indexOf(`SURF ${i}`);
  const end = L.findIndex((l, j) => j > k && /^\S/.test(l));
  return L.slice(k, end).map(l => l.trim());
};

// ---------------------------------------------------------------- reading CODE V syntax

test('seqCommands splits on ";", joins "&" continuations and drops "!" comments', () => {
  const c = seqCommands("RDM;LEN\nS 10 2 'N;BK7!x' ! comment; not a command\n  A 1e-5; B&\n 2e-8\n! whole line\nGO");
  assert.deepEqual(c.map(x => x.name), ['RDM', 'LEN', 'S', 'A', 'B', 'GO']);
  assert.deepEqual(c[2].args, ['10', '2', "'N;BK7!x'"]);
  assert.deepEqual(c[4].args, ['2e-8']);
  assert.equal(c[4].line, 3);
});

test('model glass tokens decode to exact nd / vd', () => {
  assert.deepEqual(decodeModelGlass('516800.6417'), { nd: 1.5168, vd: 64.17 });
  assert.deepEqual(decodeModelGlass('620000.581'), { nd: 1.62, vd: 58.1 });
  assert.deepEqual(decodeModelGlass('517.642'), { nd: 1.517, vd: 64.2 });
  assert.deepEqual(decodeModelGlass('2.001:29.13'), { nd: 2.001, vd: 29.13 });
  assert.equal(decodeModelGlass('NBK7_SCHOTT'), null);
});

test('curvature mode is the default; RDM switches to radii', () => {
  const lens = rdm => `${rdm}LEN\nEPD 10\nWL 587.56\nSO 0 1e10\nS 0.02 5 516800.6417\nS 0 30\nSI 0 0\n`;
  const curv = t => parseSeq(t).surfaces[1].curv;
  assert.equal(curv(lens('')), 0.02);
  assert.equal(curv(lens('RDM N\n')), 0.02);
  assert.equal(curv(lens('RDM\n')), 50);
  assert.equal(curv(lens('RDM Y\n')), 50);
});

test('refuses files without a lens', () => {
  assert.throws(() => convertSeq('! macro\nFOR ^i 1 10\nEND FOR\n', opts), ConversionError);
  assert.throws(() => convertSeq('', opts), ConversionError);
});

// ---------------------------------------------------------------- a CODE V 2026 export

test('CODE V export with zoom, OAL solve, aspheres and catalog glasses', () => {
  const res = convertSeq(fixture('codev_export.seq'), { ...opts, fileName: 'codev_export.seq' });
  const z = res.zmx;
  has(z, 'NAME WIDE');
  has(z, 'UNIT MM X W X CM MR CPMM');
  has(z, 'FNUM 2.9 1');                                       // CODE V FNO = paraxial working F/#
  has(z, 'GCAT HOYA20260707 CDGM2025011');
  has(z, 'FTYP 3 0 6 5 0 0 0 6');                             // real image height, 6 fields, 5 wavelengths
  has(z, 'YFLN 0 4.34 8.68 13.02 17.36 21.7 0 0 0 0 0 0');
  has(z, 'VDYN 0 0 -0.015 -0.03 -0.05 -0.167 0 0 0 0 0 0');    // VDY = (VLY − VUY)/2
  has(z, 'VCYN 0 0 0.035 0.09 0.2 0.4315 0 0 0 0 0 0');        // VCY = (VUY + VLY)/2
  has(z, 'WAVM 1 0.6563 3');
  has(z, 'PWAV 3');
  has(z, 'MNUM 3 1');

  const s1 = surfaceBlock(z, 1);
  assert.ok(s1.includes('COMM G1') && s1.includes('GLAS FF5 0 0 1.5927 35.45 0 0 0 0 0 0'), s1.join('\n'));
  assert.ok(s1.includes('DIAM 15 1 0 0 1 ""') && s1.includes('CLAP 0 15 0'), s1.join('\n'));
  assert.ok(surfaceBlock(z, 7).includes('TOLE 3 29.7'));      // THI S7 OAL S3..8 29.7
  assert.ok(surfaceBlock(z, 8).includes('STOP'));
  const s9 = surfaceBlock(z, 9);                               // H and J used → extended asphere
  assert.ok(s9.includes('TYPE XASPHERE') && s9.includes('CONI -0.5'), s9.join('\n'));
  assert.ok(s9.some(l => /^XDAT 7 2\.2e-13 /.test(l)), 'D joined across "&"');
  assert.ok(s9.some(l => /^XDAT 11 1\.5e-22 /.test(l)) && s9.some(l => /^XDAT 12 -2e-25 /.test(l)));
  const s10 = surfaceBlock(z, 10);
  assert.ok(s10.includes('TYPE EVENASPH') && s10.includes('PARM 2 2.5e-6') && s10.includes('PARM 3 -1e-9'));
  assert.ok(surfaceBlock(z, 11).includes('GLAS D-QK3L 0 0 1.48749 70.4405 0 0 0 0 0 0'));
  assert.ok(surfaceBlock(z, 14).includes('GLAS ___BLANK 1 0 1.5168 64.17 0 0 0 0 0 0'));

  // multi-configuration
  has(z, 'LTTL   0   1 "WIDE" 0 0 0 1 1 0 0.0 "" 0');
  has(z, 'LTTL   0   3 "TELE" 0 0 0 1 1 0 0.0 "" 0');
  has(z, 'APER   0   2 3.2 0 0 0 1 1 1.000000000000E+00 0.000000000000E+00 0 "" 0');
  has(z, 'THIC   3   2 12 1 0 0 1 1 1.000000000000E+00 0.000000000000E+00 0 "" 0');   // THC 0 → variable
  has(z, 'THIC  13   3 32 0 0 0 1 1 1.000000000000E+00 0.000000000000E+00 0 "" 0');
  has(z, 'FVDY   6   2 -0.175 0 0 0 1 1 1.000000000000E+00 0.000000000000E+00 0 "" 0');
  has(z, 'FVCY   6   3 0.465 0 0 0 1 1 1.000000000000E+00 0.000000000000E+00 0 "" 0');
  hasNot(z, /^THIC\s+7 /m);                                    // the OAL solve owns S7
  warned(res, /S7: thickness solved by the position solve/);
  assert.equal(res.warnings.filter(w => w.level === 'warn').length, 0, JSON.stringify(res.warnings));

  assert.equal(res.info.surfaces, 15);
  assert.equal(res.info.configurations, 3);
  assert.deepEqual(res.info.aperture, { key: 'FNUM', values: [2.9, 3.2, 3.6] });

  // and the .zmx reads back to the same prescription
  const back = convertZmx(z, { glassTable, fieldOrder: 'keep', waveOrder: 'keep', comments: false }).seq;
  for (const l of ['S     52.0 1.8 FF5_HOYA', 'S     0.0 1.0', '  STO', 'S     30.0 3.5 DQK3L_CDGM',
    'S     0.0 2.5 516800.6417', 'THI   S7 OAL S3..8 29.7', 'ZOO   THI S3 2.0 12.0 20.0', 'ZOO   VLY F6 0.2645 0.27 0.28']) {
    assert.ok(back.split('\r\n').includes(l), `missing after round trip: ${l}\n${back}`);
  }
});

// ---------------------------------------------------------------- round trips zmx → seq → zmx

function sag(s, r) {
  const c = s.curv, k = s.coni || 0, P = s.parm, X = s.xdat;
  let z = c * r * r / (1 + Math.sqrt(1 - (1 + k) * c * c * r * r));
  if (s.type === 'EVENASPH' || s.type === 'BINARY_2') for (let p = 1; p <= 8; p++) z += (P[p] || 0) * r ** (2 * p);
  if (s.type === 'ODDASPH') for (let p = 1; p <= 8; p++) z += (P[p] || 0) * r ** p;
  if (s.type === 'XASPHERE' || s.type === 'XOSPHERE') {
    const even = s.type === 'XASPHERE', R = X[2] || 1;
    for (let j = 1; j <= (X[1] || 0); j++) z += (X[j + 2] || 0) * (r / R) ** (even ? 2 * j : j);
  }
  return z;
}
const phase = (s, r) => {                                       // Binary 2 phase in radians
  let p = 0;
  for (let j = 1; j <= (s.xdat[1] || 0); j++) p += (s.xdat[j + 2] || 0) * (r / (s.xdat[2] || 1)) ** (2 * j);
  return p;
};

/** zmx → seq → zmx, then every surface, field, wavelength and MCE row compared with the original. */
function roundTrip(name, allowed = {}) {
  const orig = fixture(name);
  const there = convertZmx(orig, { glassTable, fieldOrder: 'keep', waveOrder: 'keep', offsetGlass: 'model' });
  const res = convertSeq(there.seq, { ...opts, fileName: name.replace(/zmx$/, 'seq') });
  const a = parseZmx(orig), b = parseZmx(res.zmx);
  const diffs = [];
  const chk = (what, x, y, tol) => {
    const same = typeof x === 'number' ? close(x, y, tol) : x === y;
    if (!same && !allowed[what]) diffs.push(`${what}: ${x} → ${y}`);
  };
  chk('surfaces', a.surfaces.length, b.surfaces.length);
  a.surfaces.forEach((s, i) => {
    const t = b.surfaces[i];
    chk(`S${i} disz`, s.disz, t.disz);
    chk(`S${i} stop`, s.stop, t.stop);
    if (s.type === 'COORDBRK') for (let p = 1; p <= 6; p++) chk(`S${i} PARM ${p}`, s.parm[p] || 0, t.parm[p] || 0);
    else for (const r of [1, 3, 6, 10]) chk(`S${i} sag`, sag(s, r), sag(t, r), 1e-12);
    if (s.type === 'BINARY_2') for (const r of [1, 3, 6]) chk(`S${i} phase`, phase(s, r), phase(t, r), 1e-12);
    if (s.glas && s.glas.name !== 'MIRROR' && t.glas && t.glas.name === '___BLANK') {
      const dn = s.glas.code === 4 ? s.glas.dn || 0 : 0;   // offset glass: base + offset
      chk(`S${i} nd`, (s.glas.nd || 0) + dn, t.glas.nd, 1e-12);
    } else chk(`S${i} glass`, s.glas ? s.glas.name : '', t.glas ? t.glas.name : '');
    // CODE V has one clear aperture (CIR): a CLAP, or else a fixed semi-diameter, becomes CIR and comes back as both
    const clear = x => { const c = x.apers.find(p => p.kind === 'CLAP'); return c ? c.max : (x.diam && x.diam.flag === 1 ? x.diam.v : 0); };
    chk(`S${i} CLAP`, clear(s), clear(t));
    chk(`S${i} TOLE`, JSON.stringify(s.tole), JSON.stringify(t.tole));
  });
  const nf = a.ftyp[2], nw = a.ftyp[3];
  chk('FTYP', a.ftyp.slice(0, 4).join(' '), b.ftyp.slice(0, 4).join(' '));
  for (const k of ['XFLN', 'YFLN', 'VDXN', 'VDYN', 'VCXN', 'VCYN']) {
    for (let f = 0; f < nf; f++) chk(`${k}[${f}]`, a.arr[k][f], b.arr[k][f]);
  }
  const wa = Object.values(a.wavm).slice(0, nw), wb = Object.values(b.wavm).slice(0, nw);
  const wmax = v => Math.max(...v.map(w => w.w));
  wa.forEach((w, j) => {
    chk(`WAVM ${j + 1}`, w.um, wb[j].um);
    chk(`WWGT ${j + 1}`, w.w / wmax(wa), wb[j].w / wmax(wb));     // CODE V weights are rescaled to integers
  });
  chk('PWAV', a.pwav, b.pwav);
  chk('aperture', a.aperture.value, b.aperture.value);
  chk('aperture type', a.aperture.type, b.aperture.type);
  chk('MNUM', a.mce.n, b.mce.n);
  const key = r => `${r.op} ${r.i1} ${r.cfg} ${r.i2}`;
  const mb = new Map(b.mce.rows.map(r => [key(r), r]));
  for (const r of a.mce.rows) {
    const o = mb.get(key(r));
    chk(key(r), r.op === 'LTTL' ? r.str : r.value, o ? (r.op === 'LTTL' ? o.str : o.value) : 'missing');
  }
  const ka = new Set(a.mce.rows.map(key));
  for (const r of b.mce.rows) if (!ka.has(key(r)) && !allowed[`extra ${key(r)}`]) diffs.push(`extra row ${key(r)}`);
  assert.deepEqual(diffs, [], `${name} round trip`);
  return { there, res, a, b };
}

test('round trip: zoom lens written by CV2ZMX.seq', () => {
  // the file has FNUM 4 0 (image space F/#); at infinity it equals the paraxial working F/#
  const { res } = roundTrip('zoom_macro.zmx', {
    'aperture type': true,
    'S8 CLAP': true,           // zoomed CIR 5 / 5.5 / 6: CLAP takes the largest so no configuration clips early
  });
  warned(res, /S8: zoomed CIR written as SDIA rows/);
});

test('round trip: focus configurations, finite conjugate F/#, offset glass, position solve', () => {
  const { there, res, b } = roundTrip('focus_pwfn.zmx');
  // CODE V gets FNO = sqrt(PWFN² + (β/2)²) for the close focus; seq2zmx undoes it
  assert.ok(/ZOO\s+FNO 2\.8 3\.01/.test(there.seq), there.seq);
  warned(res, /PWFN = sqrt\(FNO\^2 - \(beta\/2\)\^2\)/);
  const aper2 = b.mce.rows.find(r => r.op === 'APER' && r.cfg === 2);
  assert.ok(close(aper2.value, 3, 1e-9), String(aper2.value));
});

test('round trip: SPS, coordinate break, mirror, DOE', () => {
  const { res, b } = roundTrip('special_surfaces.zmx', {
    'S6 glass': true,          // OLD-GLASS is unknown both ways
  });
  assert.equal(b.surfaces[1].type, 'XASPHERE');               // EVENASPH with r² → SPS ODD → XASPHERE
  assert.equal(b.surfaces[2].type, 'XOSPHERE');               // ODDASPH → SPS ODD → XOSPHERE
  assert.equal(b.surfaces[3].type, 'COORDBRK');
  assert.equal(b.surfaces[4].glas.name, 'MIRROR');
  assert.equal(b.surfaces[5].type, 'BINARY_2');
  warned(res, /OLDGLASS_SCHOTT has no Zemax counterpart/);
});

// ---------------------------------------------------------------- special cases

test('private glass from a PRV table becomes a model glass', () => {
  const seq = `RDM;LEN\nPRV\nPWL 656.2725 587.5618 486.1327\n'MYGLASS' 1.51432 1.51680 1.52238\nEND\n`
    + `EPD 10\nWL 587.56\nSO 0 1e10\nS 50 5 MYGLASS\nS 0 45\nSI 0 0\n`;
  const res = convertSeq(seq, opts);
  const g = lines(res.zmx).find(l => l.startsWith('  GLAS '));
  const [, , , , nd, vd] = g.trim().split(/\s+/);
  assert.ok(g.startsWith('  GLAS ___BLANK 1 0 '), g);
  assert.ok(Math.abs(nd - 1.5168) < 2e-5 && Math.abs(vd - 64.14) < 0.1, g);
  warned(res, /private glass MYGLASS fitted/);
});

test('DOE becomes BINARY_2 with the phase in radians at the design wavelength', () => {
  const seq = 'RDM;LEN\nEPD 10\nWL 550\nSO 0 1e10\nS 0 2 NBK7_SCHOTT\nS 0 50\n  DIF DOE\n  HOR 1; HWL 550; HCT R\n'
    + '  HCO C1 -1e-3; HCO C2 2e-7\nSI 0 0\n';
  const z = convertSeq(seq, opts).zmx;
  const s = parseZmx(z).surfaces[2];
  assert.equal(s.type, 'BINARY_2');
  assert.equal(s.parm[0], 1);
  const k = 2 * Math.PI / 550e-6;
  assert.ok(close(s.xdat[3], k * -1e-3, 1e-12) && close(s.xdat[4], k * 2e-7, 1e-12), JSON.stringify(s.xdat));
  // and back
  const back = convertZmx(z, { glassTable, comments: false }).seq;
  assert.ok(/HCO C1 -0\.001\b|HCO C1 -1\.0e-3/.test(back), back);
});

test('decenter on a dummy surface becomes a coordinate break; elsewhere it is reported', () => {
  const seq = 'RDM;LEN\nEPD 10\nWL 587.56\nSO 0 1e10\nS 50 5 NBK7_SCHOTT\nS 0 10\nS 0 20\n  XDE 0.5; YDE -1; ADE 3\n'
    + 'S 30 4 NBK7_SCHOTT\n  YDE 0.2\nS 0 20\nSI 0 0\n';
  const res = convertSeq(seq, opts);
  const s3 = surfaceBlock(res.zmx, 3);
  assert.ok(s3.includes('TYPE COORDBRK') && s3.includes('PARM 1 0.5') && s3.includes('PARM 2 -1') && s3.includes('PARM 3 3'), s3.join('\n'));
  assert.ok(!s3.some(l => l.startsWith('GLAS')));
  assert.ok(surfaceBlock(res.zmx, 4).includes('TYPE STANDARD'));
  warned(res, /S4: decenter\/tilt \(BAS\) on a non-dummy surface not converted/);
});

test('mirror, obscuration and SPS ODD', () => {
  const seq = 'RDM;LEN\nEPD 100\nWL 550\nSO 0 1e10\nS -400 -150 REFL\n  CON; K -1\n  CIR 50; CIR OBS 12\n'
    + 'S 0 0\n  SPS ODD 0\n  SCO C1 0; SCO C2 1e-4; SCO C4 1e-6\nSI 0 0\n';
  const res = convertSeq(seq, opts);
  const s1 = surfaceBlock(res.zmx, 1), s2 = surfaceBlock(res.zmx, 2);
  for (const l of ['GLAS MIRROR 0 0 1.5 40 0 0 0 0 0 0', 'CONI -1', 'CLAP 0 50 0', 'OBSC 0 12 0']) assert.ok(s1.includes(l), s1.join('\n'));
  assert.ok(s2.includes('TYPE XOSPHERE'), s2.join('\n'));      // odd power r¹ → XOSPHERE
  assert.ok(s2.some(l => /^XDAT 3 0\.0001 /.test(l)) && s2.some(l => /^XDAT 5 1e-6 /.test(l)), s2.join('\n'));
  warned(res, /Mirrors present/);
});

test('finite conjugate F/# keeps the entrance pupil: PWFN = sqrt(FNO² − (β/2)²)', () => {
  const seq = 'RDM;LEN\nFNO 4\nWL 587.56\nSO 0 150\nS 60 5 NBK7_SCHOTT\nS -60 0\nS 0 100\n  STO\nSI 0 0\n';
  const res = convertSeq(seq, opts);
  const beta = res.info.paraxial[0].beta;
  assert.ok(Math.abs(beta) > 0.3, String(beta));
  const fnum = parseFloat(lines(res.zmx).find(l => l.startsWith('FNUM ')).split(' ')[1]);
  assert.ok(close(fnum, Math.sqrt(16 - (beta / 2) ** 2), 1e-12), String(fnum));
  // zmx2seq computes the CODE V F/# back from it
  const back = convertZmx(res.zmx, { glassTable, comments: false }).seq;
  assert.ok(/^FNO\s+4\.0\b|^FNO\s+3\.99999999|^FNO\s+4\.00000000/m.test(back), back);
});

test('missing data falls back to CODE V defaults with a note', () => {
  const res = convertSeq('LEN\nSO 0 1e10\nS 0.02 5 516800.6417\nS 0 30\nSI 0 0\n', opts);
  has(res.zmx, 'ENPD 10');
  has(res.zmx, 'WAVM 1 0.5875618 1');
  assert.ok(surfaceBlock(res.zmx, 1).includes('STOP'));
  warned(res, /No aperture in the file/);
  warned(res, /No WL in the file/);
  warned(res, /No STO in the file/);
});

test('catalog glass without a vendor suffix and glass not in the map', () => {
  const seq = 'RDM;LEN\nEPD 10\nWL 587.56\nSO 0 1e10\nS 50 5 NBK7\nS 0 2\nS 40 4 NOSUCHGLASS_ACME\nS 0 30\nSI 0 0\n';
  const res = convertSeq(seq, opts);
  assert.ok(surfaceBlock(res.zmx, 1).includes('GLAS N-BK7 0 0 1.5168 64.17 0 0 0 0 0 0'), res.zmx);
  assert.ok(surfaceBlock(res.zmx, 3).some(l => l.startsWith('GLAS NOSUCHGLASS 0 0 ')));
  warned(res, /NOSUCHGLASS_ACME has no Zemax counterpart/);
});

test('Chinese title is written as UTF-16LE with BOM; ASCII stays ASCII', () => {
  const seq = "RDM;LEN\nTITLE '测试镜头'\nEPD 10\nWL 587.56\nSO 0 1e10\nS 50 5 NBK7_SCHOTT\nS 0 45\nSI 0 0\n";
  const res = convertSeqBytes(Buffer.from(seq, 'utf8'), opts);
  has(res.zmx, 'NAME 测试镜头');
  const bytes = encodeZmx(res.zmx);
  assert.deepEqual([...bytes.subarray(0, 4)], [0xFF, 0xFE, 0x56, 0x00]);    // BOM, "V"
  assert.equal(decodeBytes(bytes).text, res.zmx);
  const ascii = encodeZmx('VERS 1\r\n');
  assert.deepEqual([...ascii], [...Buffer.from('VERS 1\r\n')]);
});
