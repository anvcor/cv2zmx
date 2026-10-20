// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  convertZmx, convertBytes, parseZmx, parseGlassTable, decodeBytes, encodeText,
  fmtNum, radiusOf, modelGlassToken, ConversionError,
} from '../web/zmx2seq.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(join(here, 'fixtures', name), 'latin1');
const glassTable = parseGlassTable(readFileSync(join(here, '..', 'CV2ZMX_GLASS.DAT'), 'latin1'));
const opts = { glassTable, date: '2026-10-20T00:00:00Z', fileName: 'test.zmx' };
const lines = seq => seq.split('\r\n');
const has = (seq, line) => assert.ok(lines(seq).includes(line), `missing line: ${line}\n${seq}`);
const hasNot = (seq, re) => assert.ok(!re.test(seq), `unexpected ${re}\n${seq}`);
const warned = (res, re) => assert.ok(res.warnings.some(w => re.test(w.en)), `no warning matching ${re}: ${JSON.stringify(res.warnings.map(w => w.en))}`);

// ---------------------------------------------------------------- formatting helpers

test('fmtNum writes CODE V numbers exactly and always with a decimal point', () => {
  assert.equal(fmtNum(0), '0.0');
  assert.equal(fmtNum(10), '10.0');
  assert.equal(fmtNum(-2.5), '-2.5');
  assert.equal(fmtNum(1e-5), '1.0e-5');
  assert.equal(fmtNum(-2.8022e-6), '-2.8022e-6');
  assert.equal(fmtNum(1.234567890123e-20), '1.234567890123e-20');
  assert.equal(fmtNum(1e10), '1.0e10');
  for (const v of [Math.PI, -1 / 3, 6.02e23, 1.5e-300, 0.1 + 0.2]) assert.equal(parseFloat(fmtNum(v)), v);
});

test('radiusOf gives a short radius whose reciprocal is the curvature to 2e-15', () => {
  assert.equal(radiusOf(0), '0.0');
  assert.equal(radiusOf(7.695859627520400432e-03), '129.94');
  assert.equal(radiusOf(1 / -19.665), '-19.665');
  const c = 0.012345678912345678;
  assert.ok(Math.abs(1 / parseFloat(radiusOf(c)) - c) <= 3e-15 * c);
});

test('model glass tokens use the nnnnnn.vvvv form (nd:vd beyond its range)', () => {
  assert.equal(modelGlassToken(1.5168, 64.17), '516800.6417');
  assert.equal(modelGlassToken(1.883, 40.8069), '883000.408069');
  assert.equal(modelGlassToken(1.62, 58.1), '620000.581');
  assert.equal(modelGlassToken(2.001, 29.13), '2.001:29.13');
});

// ---------------------------------------------------------------- decoding / encoding

test('decodes UTF-16LE with BOM, UTF-8 and GBK input', () => {
  const text = 'NAME 测试\r\n';
  const u16 = new Uint8Array([0xFF, 0xFE, ...Buffer.from(text, 'utf16le')]);
  assert.deepEqual(decodeBytes(u16), { text, encoding: 'UTF-16LE' });
  assert.equal(decodeBytes(Buffer.from(text, 'utf8')).text, text);
  const gbk = encodeText(text, 'gbk');
  assert.deepEqual([...gbk.subarray(5, 9)], [0xB2, 0xE2, 0xCA, 0xD4]);       // 测试 in GBK
  assert.deepEqual(decodeBytes(gbk), { text, encoding: 'GBK' });
});

test('a UTF-16 file converts the same as its ASCII original', () => {
  const ascii = fixture('focus_pwfn.zmx');
  const u16 = new Uint8Array([0xFF, 0xFE, ...Buffer.from(ascii, 'utf16le')]);
  const a = convertZmx(ascii, opts), b = convertBytes(u16, opts);
  assert.equal(b.info.inputEncoding, 'UTF-16LE');
  assert.equal(a.seq, b.seq);
});

// ---------------------------------------------------------------- the macro's own output, reversed

test('zoom lens written by CV2ZMX.seq converts back to the CODE V prescription', () => {
  const res = convertZmx(fixture('zoom_macro.zmx'), opts);
  const s = res.seq;
  has(s, 'RDM;LEN       "VERSION: 2026       LENS VERSION: 92       Creation Date: 20-Oct-2026"');
  has(s, "TITLE 'ZOOM TEST 3-POS'");
  has(s, 'FNO   4.0');                      // FNUM v 0 at infinite conjugate = CODE V FNO
  has(s, 'DIM   M');
  has(s, 'WL    656.2725 587.5618 486.1327');
  has(s, 'REF   2');
  has(s, 'WTW   1 2 1');
  has(s, 'TEM   22.0');
  has(s, 'XRI   0.0 0.0 0.0');
  has(s, 'YRI   0.0 8.0 12.0');
  // inverse of the macro: VCY = (VUY+VLY)/2, VDY = (VLY-VUY)/2
  has(s, 'VUY   0.0 0.12 0.25');
  has(s, 'VLY   0.0 0.08 0.15');
  has(s, 'VUX   0.0 0.0 0.01');
  has(s, 'SO    0.0 0.1e11');
  has(s, 'S     52.0 1.8 FF5_HOYA');
  has(s, 'S     30.0 6.0 HK9L_CDGM');
  has(s, 'S     22.0 4.5 MTAFD315_HOYA');
  has(s, 'S     30.0 3.5 DQK3L_CDGM');
  has(s, '  SLB "G1"');
  has(s, '  CIR 15.0');
  // XASPHERE with r^18 / r^20 → ASP A..J, exact
  has(s, '  A -1.2e-5; B 3.4e-8; C -1.1e-10; D 2.2e-13');
  has(s, '  E 0.0; F 0.0; G 0.0; H 1.5e-22');
  has(s, '  J -2.0e-25');
  has(s, '  K   -0.5');
  has(s, 'SI    0.0 0.0');
  // zoom
  has(s, 'ZOO   3');
  has(s, 'TIT   Z1 "WIDE"');
  has(s, 'TIT   Z3 "TELE"');
  has(s, 'ZOO   FNO 4.0 4.8 5.6');
  has(s, 'ZOO   THI S3 2.0 12.0 20.0');
  has(s, 'ZOO THC S3 100 100 100');
  has(s, 'ZOO   THI S13 30.0 32.0 35.0');
  has(s, 'ZOO   VUY F3 0.25 0.33 0.42');
  has(s, 'ZOO   VLY F3 0.15 0.17 0.18');
  has(s, 'ZOO   VUX F3 0.01 0.02 0.03');
  has(s, 'ZOO   CIR S8 5.0 5.5 6.0');
  has(s, 'ZOO   A S9 -1.2e-5 -1.3e-5 -1.4e-5');
  assert.equal(lines(s).at(-2), 'GO');
  assert.equal(res.warnings.filter(w => w.level === 'warn').length, 0, JSON.stringify(res.warnings));
  assert.equal(res.info.configurations, 3);
  assert.ok(res.info.paraxial[0].efl < res.info.paraxial[2].efl);
});

// ---------------------------------------------------------------- OpticStudio file with focus positions

test('paraxial working F/#, position solve, focus variable and glass solves', () => {
  const res = convertZmx(fixture('focus_pwfn.zmx'), opts);
  const s = res.seq;
  const p = res.info.paraxial;
  assert.equal(p[0].finite, false);
  assert.equal(p[1].finite, true);
  // FNO_CV^2 = PWFN^2 + (beta/2)^2 on the finite conjugate, unchanged at infinity
  const fno2 = Math.sqrt(3.0 ** 2 + (p[1].beta / 2) ** 2);
  has(s, 'FNO   2.8');
  has(s, `ZOO   FNO 2.8 ${fmtNum(Math.round(fno2 * 1e12) / 1e12)}`);
  assert.ok(Math.abs(fno2 - 3.0105) < 1e-4);
  has(s, 'WL    656.2725 587.5618 486.1327');       // ascending in the file, descending in CODE V
  has(s, 'REF   2');
  has(s, 'WTW   10 25 10');                         // 1 / 2.5 / 1 scaled to integers
  has(s, 'XAN   0.0 0.0 0.0');
  has(s, 'YAN   0.0 14.0 20.0');
  has(s, 'THI   S11 OAL S6..12 47.0');
  hasNot(s, /ZOO   THI S11/);
  has(s, 'ZOO   THI S0 0.1e11 300.0');
  has(s, 'ZOO   THI S6 6.0 7.5');
  has(s, 'ZOO THC S6 0 0');                         // variable in the MCE → CODE V variable
  has(s, 'S     40.0 4.0 SLAH66_OHARA');            // offset glass → base glass (default)
  has(s, 'S     22.0 5.0 620000.581');              // model glass
  has(s, 'S     60.0 1.5 EFD10_HOYA');
  has(s, '  CIR 14.5');                             // fixed semi-diameter
  has(s, '  CIR 7.2');
  warned(res, /offset glass written as its base glass SLAH66_OHARA/);
  warned(res, /dPgF 0\.0021 dropped/);

  const m = convertZmx(fixture('focus_pwfn.zmx'), { ...opts, offsetGlass: 'model', oal: false, zoomVars: false, sd: 'aperture' });
  has(m.seq, 'S     40.0 4.0 773699.492984');         // 1.772499+0.0012, 49.5984-0.3
  hasNot(m.seq, /OAL/);
  has(m.seq, 'ZOO THC S6 100 100');
  hasNot(m.seq, /CIR 14\.5/);
});

test('image space F/# with a finite conjugate becomes EPD = EFL / F#', () => {
  const zmx = fixture('focus_pwfn.zmx').replace('FNUM 2.8 1', 'FNUM 2.8 0');
  const res = convertZmx(zmx, opts);
  const p = res.info.paraxial;
  has(res.seq, `EPD   ${fmtNum(Math.round(p[0].efl / 2.8 * 1e12) / 1e12)}`);
  assert.match(res.seq, /ZOO   EPD /);
  warned(res, /Image space F\/# with a finite conjugate/);
});

// ---------------------------------------------------------------- special surfaces

test('special surfaces: SPS ODD, coordinate break, mirror, DOE, apertures', () => {
  const res = convertZmx(fixture('special_surfaces.zmx'), opts);
  const s = res.seq;
  has(s, 'EPD   20.0');
  has(s, 'TEM   25.0');
  has(s, 'PRE   684.0');
  has(s, 'XOB   0.0 0.0');
  has(s, 'YOB   0.0 5.0');
  has(s, 'VUX   0.0 0.04');
  has(s, 'VLX   0.0 0.06');
  has(s, 'SO    0.0 100.0');
  // EVENASPH with an r^2 term → SPS ODD, C(n+1) = r^n
  has(s, '  SPS ODD 0.0');
  has(s, '  SCO C3 0.001');
  has(s, '  SCO C5 1.0e-6');
  // ODDASPH r^3, r^4
  has(s, '  SCO C1 -1.2');
  has(s, '  SCO C4 2.0e-5');
  // coordinate break → basic decenter on a dummy surface
  has(s, 'S     0.0 20.0');
  has(s, '  XDE 0.5; YDE -1.0; ZDE 0.0');
  has(s, '  ADE 10.0; BDE 0.0; CDE 0.0');
  // mirror + conic + annular aperture + obscuration
  has(s, 'S     -200.0 -20.0 REFL');
  has(s, '  CON');
  has(s, '  K   -1.0');
  has(s, '  CIR 25.0');
  has(s, '  CIR OBS 2.0');
  has(s, '  CIR OBS 3.0');
  // Binary 2: HCO Cj = Aj * lambda0 / 2pi / Rn^(2j)
  const lam = 550e-6;
  has(s, '  DIF DOE');
  has(s, '  HOR 1.0');
  has(s, '  HWL 550.0; HCT R');
  has(s, `  HCO C1 ${fmtNum(-50 * lam / (2 * Math.PI) / 100)}`);
  has(s, `  HCO C2 ${fmtNum(2 * lam / (2 * Math.PI) / 1e4)}`);
  // glasses missing from the table
  has(s, 'S     0.0 -2.0 600000.42');
  has(s, 'S     100.0 -10.0 OLDGLASS_SCHOTT');
  warned(res, /XYZ-123 has no CODE V counterpart/);
  warned(res, /OLD-GLASS is not in the glass map and the file has no usable nd\/vd/);
  warned(res, /RCTA aperture not converted/);
  warned(res, /S6: surface tilt\/decenter not converted/);
  warned(res, /surface type TOROIDAL not supported/);
  // every warning also lands in the file as a comment
  for (const w of res.warnings.filter(x => x.level === 'warn')) has(s, `! WARNING: ${w.en}`);
});

test('coordinate break with tilt-before-decenter order is reported, not guessed', () => {
  const zmx = fixture('special_surfaces.zmx').replace('PARM 6 0', 'PARM 6 1');
  const res = convertZmx(zmx, opts);
  warned(res, /order 1 \(tilt before decenter\)/);
  hasNot(res.seq, /XDE 0\.5/);
});

// ---------------------------------------------------------------- minimal / old files and errors

test('minimal old-style file without TYPE lines', () => {
  const zmx = [
    'VERS 171115', 'MODE SEQ', 'NAME 55278 Mounted Achromat Pair', 'UNIT MM X W X CM MR CPMM', 'ENPD 22',
    'GCAT SCHOTT INFRARED MISC', 'FTYP 0 0 1 3 0 0 0 1', 'XFLN 0', 'YFLN 0', 'FWGN 1',
    'WAVM 1 0.48609999999999998 1', 'WAVM 2 0.58760000000000001 1', 'WAVM 3 0.65629999999999999 1', 'PWAV 2',
    'SURF 0', '  CURV 0.0', '  DISZ INFINITY',
    'SURF 1', '  STOP', '  CURV 7.695859627520400432E-03', '  DISZ 2.5', '  GLAS SF5',
    'SURF 2', '  CURV 2.240143369175629992E-02', '  DISZ 6', '  GLAS BK7',
    'SURF 3', '  CURV -1.626809825931349943E-02', '  DISZ 43.7',
    'SURF 4', '  CURV 0.0', '  DISZ 0',
  ].join('\n');
  const res = convertZmx(zmx, opts);
  has(res.seq, 'EPD   22.0');
  has(res.seq, 'WL    656.3 587.6 486.1');
  has(res.seq, 'S     129.94 2.5 SF5_SCHOTT');      // SF5 exists in SCHOTT, HIKARI and SUMITA: GCAT decides
  has(res.seq, 'S     44.64 6.0 BK7_SCHOTT');
  has(res.seq, '  STO');
});

test('refuses non-sequential files and files without surfaces', () => {
  assert.throws(() => convertZmx('MODE NSC\nSURF 0\nSURF 1\n', opts), ConversionError);
  assert.throws(() => convertZmx('VERS 1\nMODE SEQ\n', opts), ConversionError);
  assert.throws(() => convertZmx('MODE SEQ\nUNIT METER\nSURF 0\nSURF 1\n', opts), /METER/);
});

test('without the glass table every catalog glass becomes a model glass', () => {
  const res = convertZmx(fixture('zoom_macro.zmx'), { ...opts, glassTable: null });
  has(res.seq, 'S     52.0 1.8 592700.3545');
  warned(res, /Glass map CV2ZMX_GLASS\.DAT not loaded/);
});

test('glass reverse lookup prefers the catalogs listed in GCAT', () => {
  const zmx = fixture('zoom_macro.zmx');
  // H-K9L exists in CDGM and NHG: with only NHG in GCAT the NHG spelling must win
  const res = convertZmx(zmx.replace('GCAT CDGM2025011 HOYA20260707', 'GCAT NHG HOYA20260707'), opts);
  has(res.seq, 'S     30.0 6.0 HK9L_NHG');
});

test('parseZmx keeps MCE rows and ignores the merit function in front of them', () => {
  const m = parseZmx(fixture('zoom_macro.zmx'));
  assert.equal(m.mce.n, 3);
  assert.equal(m.mce.rows.filter(r => r.op === 'THIC').length, 9);
  assert.ok(!m.mce.rows.some(r => r.op === 'CONF' || r.op === 'BLNK'));
  assert.equal(m.surfaces.length, 15);
  assert.equal(m.surfaces[9].xdat[11], 1.5e-22);
});

test('fields are reordered on-axis first together with their vignetting (or kept on request)', () => {
  let zmx = fixture('focus_pwfn.zmx')
    .replace('YFLN 0 14 20 0', 'YFLN 20 14 0 0')
    .replace('VDYN 0 0 0 0', 'VDYN -0.1 -0.05 0 0')
    .replace('VCYN 0 0 0 0', 'VCYN 0.3 0.1 0 0');
  zmx += 'FVCY   1   1 0.3 0 0 0 1 1 1 0 0\nFVCY   1   2 0.35 0 0 0 1 1 1 0 0\n';
  const res = convertZmx(zmx, opts);
  has(res.seq, 'YAN   0.0 14.0 20.0');
  has(res.seq, 'VUY   0.0 0.15 0.4');        // 0.1-(-0.05), 0.3-(-0.1)
  has(res.seq, 'VLY   0.0 0.05 0.2');
  has(res.seq, 'ZOO   VUY F3 0.4 0.45');      // Zemax field 1 is CODE V F3
  has(res.seq, 'ZOO   VLY F3 0.2 0.25');
  const keep = convertZmx(zmx, { ...opts, fieldOrder: 'keep' });
  has(keep.seq, 'YAN   20.0 14.0 0.0');
  has(keep.seq, 'ZOO   VUY F1 0.4 0.45');
});

test('Chinese title survives as GBK', () => {
  const zmx = fixture('focus_pwfn.zmx').replace('NAME FOCUS TEST INF/CLOSE', 'NAME 测试镜头');
  const res = convertZmx(zmx, opts);
  has(res.seq, "TITLE '测试镜头'");
  const bytes = encodeText(res.seq, 'gbk');
  assert.equal(new TextDecoder('gbk').decode(bytes), res.seq);
});
