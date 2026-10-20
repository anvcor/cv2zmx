/*
 * zmx2seq.js — Zemax OpticStudio sequential lens file (.zmx)  →  CODE V sequence file (.seq)
 *
 * The reverse direction of CV2ZMX.seq in this repository.  One ES module with no
 * dependencies: the web page (web/index.html), the command line tool
 * (tools/zmx2seq.mjs) and the tests all run this same file.
 *
 * Mapping summary (each line is the inverse of what CV2ZMX.seq writes):
 *   UNIT MM/CM/IN            → DIM M/C/I
 *   ENPD / FNUM v 0|1 / OBNA → EPD / FNO / NAO        (see apertureValues())
 *   FTYP 0/1/2/3 + X/YFLN    → XAN YAN / XOB YOB / XIM YIM / XRI YRI
 *   VDX VDY VCX VCY          → VUX = VCX−VDX, VLX = VCX+VDX, VUY = VCY−VDY, VLY = VCY+VDY
 *   WAVM µm                  → WL nm (descending, REF/WTW re-indexed)
 *   ENVD t p                 → TEM t, PRE p·760
 *   STANDARD + CONI          → CON + K
 *   EVENASPH PARM 2..8       → ASP + K + A..G
 *   XASPHERE XDAT 4..12      → ASP + K + A..J   (divided by Rn^(2i) when Rn ≠ 1)
 *   r², odd or > r²⁰ terms   → SPS ODD
 *   BINARY_2                 → DIF DOE (HCO Cj = Aj·λ0/2π / Rn^(2j))
 *   COORDBRK                 → dummy surface with XDE/YDE + ADE/BDE/CDE
 *   GLAS name (catalog)      → NAME_CATALOG via CV2ZMX_GLASS.DAT (reverse lookup)
 *   GLAS ___BLANK nd vd      → model glass nnnnnn.vvvv
 *   GLAS MIRROR              → REFL
 *   CLAP / FLAP / fixed DIAM → CIR,  OBSC → CIR OBS
 *   TOLE from len            → THI Sk OAL Sfrom..k+1 len
 *   MNUM + MCE rows          → ZOO n + ZOO ... rows
 * Whatever cannot be carried over is reported, never dropped silently.
 */

export const VERSION = '1.0.0';

const INF_THI = 1e10;           // |thickness| ≥ this is infinity (same as CV2ZMX.seq)
const LAMBDA_D = 0.5875618, LAMBDA_F = 0.4861327, LAMBDA_C = 0.6562725;
const MM_PER_UNIT = { MM: 1, CM: 10, IN: 25.4 };
const ASP_LETTERS = { 4: 'A', 6: 'B', 8: 'C', 10: 'D', 12: 'E', 14: 'F', 16: 'G', 18: 'H', 20: 'J' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const DEFAULTS = Object.freeze({
  glassTable: null,          // parseGlassTable(CV2ZMX_GLASS.DAT)
  sd: 'fixed',               // which semi-diameters become CIR: 'aperture' | 'fixed' | 'all'
  offsetGlass: 'base',       // Zemax offset glass: 'base' (catalog base glass) | 'model' (nd/vd incl. offset)
  unknownGlass: 'model',     // glass missing from the table: 'model' | 'guess'
  oal: true,                 // TOLE position solve → THI ... OAL
  zoomVars: true,            // MCE THIC status "variable" → ZOO THC 0
  waveOrder: 'descending',   // 'descending' (CODE V habit) | 'keep'
  fieldOrder: 'ascending',   // 'ascending' (on-axis field first, CODE V habit) | 'keep'
  comments: true,            // header comments with source, warnings and a paraxial check
  fileName: '',
  title: '',
  date: null,                // Date used in the RDM;LEN line (tests pin it)
});

// ======================================================================
// Messages
// ======================================================================

export class ConversionError extends Error {
  constructor(zh, en) { super(en); this.zh = zh; this.en = en; }
}

class Log {
  constructor() { this.items = []; }
  add(level, zh, en) {
    if (!this.items.some(i => i.en === en)) this.items.push({ level, zh, en });
  }
  warn(zh, en) { this.add('warn', zh, en); }
  info(zh, en) { this.add('info', zh, en); }
}

// ======================================================================
// Text decoding / encoding
// ======================================================================

/** Decode .zmx bytes. OpticStudio writes UTF-16LE with BOM by default; older
 *  versions write ANSI (GBK on a Chinese Windows). */
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dec = (label, buf) => new TextDecoder(label).decode(buf);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return { text: dec('utf-16le', u8.subarray(2)), encoding: 'UTF-16LE' };
  if (u8[0] === 0xFE && u8[1] === 0xFF) return { text: dec('utf-16be', u8.subarray(2)), encoding: 'UTF-16BE' };
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return { text: dec('utf-8', u8.subarray(3)), encoding: 'UTF-8' };
  let even = 0, odd = 0;
  const n = Math.min(u8.length, 4096);
  for (let i = 0; i < n; i++) if (u8[i] === 0) (i % 2 ? odd++ : even++);
  if (odd > n / 4) return { text: dec('utf-16le', u8), encoding: 'UTF-16LE' };
  if (even > n / 4) return { text: dec('utf-16be', u8), encoding: 'UTF-16BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: /[^\x00-\x7f]/.test(dec('latin1', u8)) ? 'UTF-8' : 'ASCII' };
  } catch { /* not UTF-8 */ }
  try { return { text: dec('gbk', u8), encoding: 'GBK' }; } catch { /* no GBK decoder */ }
  return { text: dec('windows-1252', u8), encoding: 'Windows-1252' };
}

let GBK_MAP = null;
function gbkMap() {
  if (GBK_MAP) return GBK_MAP;
  GBK_MAP = new Map();
  const dec = new TextDecoder('gbk');
  const buf = new Uint8Array(2);
  for (let a = 0x81; a <= 0xFE; a++) {
    for (let b = 0x40; b <= 0xFE; b++) {
      if (b === 0x7F) continue;
      buf[0] = a; buf[1] = b;
      const ch = dec.decode(buf);
      if (ch.length === 1 && ch !== '\uFFFD' && !GBK_MAP.has(ch)) GBK_MAP.set(ch, (a << 8) | b);
    }
  }
  return GBK_MAP;
}

/** Encode the .seq text. CODE V on a Chinese Windows reads GBK, which is also
 *  what CV2ZMX.seq itself is saved in. Pure ASCII is identical in both. */
export function encodeText(text, encoding = 'gbk') {
  if (encoding === 'utf-8' || !/[^\x00-\x7f]/.test(text)) return new TextEncoder().encode(text);
  const map = gbkMap();
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (map.has(ch)) { const v = map.get(ch); out.push(v >> 8, v & 0xFF); }
    else out.push(0x3F);
  }
  return Uint8Array.from(out);
}

// ======================================================================
// Small helpers
// ======================================================================

const splitTokens = s => s.match(/"[^"]*"?|\S+/g) || [];
const unquote = t => (t && t[0] === '"') ? t.replace(/^"/, '').replace(/"$/, '') : (t ?? '');
const normName = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const round12 = v => (Math.abs(v) < 1e-13 ? 0 : Math.round(v * 1e12) / 1e12);
const nearlyEqual = (a, b) => a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const allEqual = arr => arr.every(v => (typeof v === 'number' ? nearlyEqual(v, arr[0]) : v === arr[0]));

function num(t, dflt = 0) {
  if (t === undefined || t === null) return dflt;
  const u = String(t).toUpperCase();
  if (u === 'INFINITY' || u === 'INF') return Infinity;
  if (u === '-INFINITY') return -Infinity;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : dflt;
}

/** CODE V number: shortest exact representation, always with a decimal point. */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return v > 0 ? '0.1e11' : '-0.1e11';
  if (v === 0) return '0.0';
  const a = Math.abs(v);
  let s = (a >= 1e-4 && a < 1e10) ? String(v) : v.toExponential();
  if (s.includes('e')) {
    let [m, e] = s.split('e');
    if (!m.includes('.')) m += '.0';
    return m + 'e' + e.replace('+', '');
  }
  return s.includes('.') ? s : s + '.0';
}

const fmtThi = v => (Math.abs(v) >= INF_THI ? (v > 0 ? '0.1e11' : '-0.1e11') : fmtNum(v));

/** Radius for a curvature (Zemax stores curvature, CODE V reads radius): the shortest
 *  decimal within 2e-15 (relative) of 1/c, so 129.94 rather than 129.93999999999988. */
export function radiusOf(c) {
  if (c === 0) return '0.0';
  const r = 1 / c;
  for (let p = 6; p <= 16; p++) {
    const v = parseFloat(r.toPrecision(p));
    if (Math.abs(v - r) <= 2e-15 * Math.abs(r)) return fmtNum(v);
  }
  return fmtNum(r);
}

/** CODE V model glass: nnnnnn.vvvv  (nd − 1 in millionths, vd / 100), or nd:vd. */
export function modelGlassToken(nd, vd) {
  if (nd >= 1 && nd < 2 && vd > 0 && vd < 100) {
    const n6 = Math.round((nd - 1) * 1e6);
    if (n6 < 1e6) {
      const v = (vd / 100).toFixed(6).split('.')[1].replace(/0+$/, '') || '0';
      return String(n6).padStart(6, '0') + '.' + v;
    }
  }
  return `${fmtNum(nd)}:${fmtNum(vd)}`;
}

/** Refractive index at `um` estimated from nd / vd with a two-term Cauchy model.
 *  Only used for the paraxial check and for β in the F/# conversion. */
function cauchyIndex(nd, vd, um) {
  if (!(nd > 1) || !(vd > 0)) return nd > 0 ? nd : 1;
  const B = (nd - 1) / vd / (1 / (LAMBDA_F * LAMBDA_F) - 1 / (LAMBDA_C * LAMBDA_C));
  return nd - B / (LAMBDA_D * LAMBDA_D) + B / (um * um);
}

function codevDate(d) {
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

// ======================================================================
// Glass table  (CV2ZMX_GLASS.DAT: CVNAME_CAT  ZNAME  ZCATALOG  nd  vd)
// ======================================================================

export function parseGlassTable(text) {
  const rows = [];
  for (const ln of String(text).split(/\r?\n/)) {
    const f = ln.trim().split(/\s+/);
    if (f.length < 3) continue;
    const k = f[0].lastIndexOf('_');
    if (k <= 0) continue;
    rows.push({
      cv: f[0].toUpperCase(), cvCat: f[0].slice(k + 1).toUpperCase(),
      zname: f[1], zcat: f[2], nd: num(f[3], NaN), vd: num(f[4], NaN),
    });
  }
  const byZ = new Map(), byNorm = new Map(), zcatVendor = new Map(), vendors = new Set();
  const add = (map, key, r) => { if (!map.has(key)) map.set(key, []); map.get(key).push(r); };
  for (const r of rows) {
    add(byZ, r.zname.toUpperCase(), r);
    add(byNorm, normName(r.zname), r);
    if (!zcatVendor.has(r.zcat.toUpperCase())) zcatVendor.set(r.zcat.toUpperCase(), r.cvCat);
    vendors.add(r.cvCat);
  }
  return { size: rows.length, byZ, byNorm, zcatVendor, vendors: [...vendors].sort((a, b) => b.length - a.length) };
}

function vendorOf(table, zcat) {
  const U = zcat.toUpperCase();
  if (table.zcatVendor.has(U)) return table.zcatVendor.get(U);
  return table.vendors.find(v => U.includes(v)) || null;   // longest first: HIKARI before NIKON
}

function lookupGlass(table, zname, gcat) {
  if (!table) return null;
  const U = zname.toUpperCase();
  const cands = table.byZ.get(U) || table.byNorm.get(normName(U)) || [];
  if (!cands.length) return null;
  for (const g of gcat) {
    const c = cands.find(r => r.zcat.toUpperCase() === g.toUpperCase());
    if (c) return { row: c, inGcat: true };
  }
  for (const g of gcat) {
    const v = vendorOf(table, g);
    const c = v && cands.find(r => r.cvCat === v);
    if (c) return { row: c, inGcat: true };
  }
  return { row: cands[0], inGcat: false };
}

// ======================================================================
// .zmx parser
// ======================================================================

const SURFACE_KEYS = new Set(['TYPE', 'CURV', 'DISZ', 'GLAS', 'CONI', 'PARM', 'XDAT', 'DIAM',
  'STOP', 'COMM', 'CLAP', 'FLAP', 'OBSC', 'OBDC', 'TOLE', 'SCBD', 'SCAD']);
const UNSUPPORTED_APERTURES = new Set(['ELAP', 'EOBS', 'RCTA', 'RCTO', 'SQAP', 'SQOB', 'SPID',
  'UDAP', 'UDOB', 'USAP', 'UDAD', 'UDOD']);
const THICKNESS_SOLVES = { MAZH: 'marginal ray height', PZUP: 'pickup', CBSO: 'chief ray height',
  EDGE: 'edge thickness', OPTH: 'optical path' };
const MCE_END = new Set(['CONF', 'DMFS', 'BLNK', 'TOL', 'TOLE']);

function newSurface(idx) {
  return { idx, type: 'STANDARD', stop: false, comm: '', curv: 0, disz: 0, glas: null, coni: 0,
    parm: {}, xdat: {}, diam: null, apers: [], aperDec: null, tole: null, tilt: false, solves: [] };
}

export function parseZmx(text) {
  const m = {
    version: '', mode: 'SEQ', name: '', notes: [], unit: 'MM', aperture: null,
    env: { temp: 20, pres: 1 }, gcat: [], ftyp: null, arr: {}, wavm: {}, pwav: 1,
    surfaces: [], mce: { n: 1, cur: 1, rows: [] },
  };
  let cur = null, inMce = false, seenSurf = false;
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    if (!raw.trim()) continue;
    const indented = /^\s/.test(raw);
    const t = raw.trim();
    const sp = t.search(/\s/);
    const key = (sp < 0 ? t : t.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    const toks = splitTokens(rest);

    if (key === 'SURF') {
      cur = newSurface(num(toks[0], m.surfaces.length));
      m.surfaces.push(cur); seenSurf = true; inMce = false;
      continue;
    }
    if (cur && (indented || SURFACE_KEYS.has(key))) { surfaceLine(cur, key, toks, rest); continue; }
    cur = null;

    if (inMce) {
      if (MCE_END.has(key)) { inMce = false; continue; }
      const i1 = parseInt(toks[0], 10), cfg = parseInt(toks[1], 10);
      if (/^[A-Z0-9]{4}$/.test(key) && Number.isInteger(i1) && Number.isInteger(cfg)
          && cfg >= 1 && cfg <= m.mce.n && toks.length >= 3) {
        m.mce.rows.push({ op: key, i1, cfg, tok: toks[2], value: num(toks[2], NaN), str: unquote(toks[2]),
          status: num(toks[3], 0), i2: num(toks[4], 0) });
      }
      continue;
    }

    switch (key) {
      case 'VERS': m.version = rest; break;
      case 'MODE': m.mode = (toks[0] || 'SEQ').toUpperCase(); break;
      case 'NAME': m.name = unquote(rest).trim(); break;
      case 'NOTE': { const n = rest.replace(/^\d+\s?/, '').trim(); if (n && n !== '""') m.notes.push(unquote(n)); break; }
      case 'UNIT': m.unit = (toks[0] || 'MM').toUpperCase(); break;
      case 'ENPD': m.aperture = { type: 'ENPD', value: num(toks[0]) }; break;
      case 'FNUM': m.aperture = { type: num(toks[1]) === 1 ? 'PWFN' : 'ISFN', value: num(toks[0]) }; break;
      case 'OBNA': m.aperture = { type: num(toks[1]) === 1 ? 'CONE' : 'OBNA', value: num(toks[0]) }; break;
      case 'FLOA': m.aperture = { type: 'FLOA', value: 0 }; break;
      case 'ENVD': m.env = { temp: num(toks[0], 20), pres: num(toks[1], 1) }; break;
      case 'GCAT': m.gcat = toks.map(unquote).filter(Boolean); break;
      case 'FTYP': m.ftyp = toks.map(x => num(x)); break;
      case 'XFLN': case 'YFLN': case 'FWGN': case 'VDXN': case 'VDYN': case 'VCXN': case 'VCYN':
      case 'VANN': case 'XFLD': case 'YFLD': case 'FWGT': case 'WAVN': case 'WWGN': case 'WAVL': case 'WWGT':
        m.arr[key] = toks.map(x => num(x)); break;
      case 'WAVM': m.wavm[num(toks[0])] = { um: num(toks[1], 0.55), w: num(toks[2], 1) }; break;
      case 'PWAV': m.pwav = num(toks[0], 1); break;
      case 'MNUM': m.mce.n = Math.max(1, num(toks[0], 1)); m.mce.cur = num(toks[1], 1); inMce = seenSurf; break;
      default: break;
    }
  }
  m.surfaces.sort((a, b) => a.idx - b.idx);
  return m;
}

function surfaceLine(s, key, toks, rest) {
  switch (key) {
    case 'TYPE': s.type = (toks[0] || 'STANDARD').toUpperCase(); break;
    case 'STOP': s.stop = true; break;
    case 'COMM': s.comm = unquote(rest).trim(); break;
    case 'CURV': s.curv = num(toks[0]); break;
    case 'DISZ': s.disz = num(toks[0]); break;
    case 'CONI': s.coni = num(toks[0]); break;
    case 'PARM': s.parm[num(toks[0])] = num(toks[1]); break;
    case 'XDAT': s.xdat[num(toks[0])] = num(toks[1]); break;
    case 'DIAM': s.diam = { v: num(toks[0]), flag: num(toks[1]) }; break;
    case 'GLAS':
      // GLAS name code pickup nd vd dPgF ? ? ? dNd dVd   (code 0 fixed, 1 model, 2 pickup, 3 substitute, 4 offset)
      s.glas = { name: unquote(toks[0] || ''), code: num(toks[1]), nd: num(toks[3]), vd: num(toks[4]),
        dpgf: num(toks[5]), dn: num(toks[9]), dv: num(toks[10]) };
      break;
    case 'CLAP': case 'FLAP': case 'OBSC':
      s.apers.push({ kind: key, min: num(toks[0]), max: num(toks[1]) }); break;
    case 'OBDC': s.aperDec = { x: num(toks[0]), y: num(toks[1]) }; break;
    case 'TOLE': s.tole = { from: num(toks[0]), len: num(toks[1]) }; break;
    case 'SCBD': case 'SCAD':
      if (toks.slice(3).some(x => num(x) !== 0)) s.tilt = true;
      break;
    default:
      if (UNSUPPORTED_APERTURES.has(key)) s.apers.push({ kind: key, unsupported: true });
      else if (THICKNESS_SOLVES[key]) s.solves.push(key);
      break;
  }
}

// ======================================================================
// Model helpers: fields, wavelengths, MCE lookup
// ======================================================================

function compileFields(m) {
  const A = m.arr;
  const X = A.XFLN || A.XFLD || [], Y = A.YFLN || A.YFLD || [], W = A.FWGN || A.FWGT || [];
  let nf = m.ftyp && m.ftyp.length > 2 ? m.ftyp[2] : 0;
  if (!nf) {
    if (A.YFLD || A.XFLD) nf = Math.max(Y.length, X.length);
    else { nf = 1; for (let i = 0; i < Math.max(X.length, Y.length); i++) if (X[i] || Y[i]) nf = i + 1; }
  }
  const fields = [];
  for (let i = 0; i < nf; i++) {
    fields.push({ x: X[i] || 0, y: Y[i] || 0, w: W[i] ?? 1,
      vdx: A.VDXN?.[i] || 0, vdy: A.VDYN?.[i] || 0, vcx: A.VCXN?.[i] || 0, vcy: A.VCYN?.[i] || 0, van: A.VANN?.[i] || 0 });
  }
  return fields;
}

function compileWaves(m, log) {
  let nw = m.ftyp && m.ftyp.length > 3 ? m.ftyp[3] : 0;
  const idx = Object.keys(m.wavm).map(Number).sort((a, b) => a - b);
  let waves = [];
  if (idx.length) {
    if (!nw) nw = idx.length;
    for (let i = 1; i <= nw; i++) waves.push(m.wavm[i] || { um: 0.55, w: 1 });
  } else if (m.arr.WAVN) {
    if (!nw) nw = m.arr.WAVN.filter(v => v > 0).length;
    waves = m.arr.WAVN.slice(0, nw).map((um, i) => ({ um, w: m.arr.WWGN?.[i] ?? 1 }));
  } else if (m.arr.WAVL) {
    waves = m.arr.WAVL.map((um, i) => ({ um, w: m.arr.WWGT?.[i] ?? 1 }));
  }
  if (!waves.length) {
    log.warn('文件里没有波长数据，按 0.55 µm 单波长写出。', 'No wavelength data in the file; wrote a single 0.55 um wavelength.');
    waves = [{ um: 0.55, w: 1 }];
  }
  return waves;
}

/** Group MCE rows: key "OP|i1|i2" → { op, i1, i2, rows[cfg] } */
function groupMce(m) {
  const groups = new Map();
  for (const r of m.mce.rows) {
    const useI2 = r.op === 'PRAM' || r.op === 'EDVA' || r.op === 'XDAT';
    const k = `${r.op}|${r.i1}|${useI2 ? r.i2 : 0}`;
    if (!groups.has(k)) groups.set(k, { op: r.op, i1: r.i1, i2: useI2 ? r.i2 : 0, rows: [] });
    groups.get(k).rows[r.cfg] = r;
  }
  return groups;
}

// ======================================================================
// Conversion
// ======================================================================

export function convertBytes(bytes, opts = {}) {
  const { text, encoding } = decodeBytes(bytes);
  const res = convertZmx(text, opts);
  res.info.inputEncoding = encoding;
  return res;
}

export function convertZmx(text, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const log = new Log();
  const m = parseZmx(text);

  if (m.mode !== 'SEQ') {
    throw new ConversionError(`这是非序列/混合模式文件（MODE ${m.mode}），只支持序列模式。`,
      `MODE ${m.mode} file: only sequential (MODE SEQ) lenses can be converted.`);
  }
  if (m.surfaces.length < 2) {
    throw new ConversionError('没有读到面数据（SURF），这不像是 .zmx 镜头文件。',
      'No SURF data found - this does not look like a .zmx lens file.');
  }
  const S = m.surfaces;
  S.forEach((s, i) => {
    if (s.idx !== i) {
      throw new ConversionError(`面号不连续（第 ${i} 个面写的是 SURF ${s.idx}）。`, `Surface numbers are not contiguous (SURF ${s.idx} at position ${i}).`);
    }
  });
  const N = S.length - 1;                      // image surface number
  const dim = { MM: 'M', CM: 'C', IN: 'I', INCH: 'I' }[m.unit];
  if (!dim) {
    throw new ConversionError(`镜头单位 ${m.unit} 在 CODE V 里没有对应（只支持 mm / cm / inch），请先在 Zemax 里换成 mm。`,
      `Lens unit ${m.unit} has no CODE V equivalent (mm / cm / inch only); rescale the lens to mm in Zemax first.`);
  }
  const mmPerUnit = MM_PER_UNIT[m.unit === 'INCH' ? 'IN' : m.unit];
  if (!m.aperture) {
    log.warn('文件里没有系统孔径（ENPD/FNUM/OBNA/FLOA），按 EPD 10 写出。', 'No system aperture in the file; wrote EPD 10.');
    m.aperture = { type: 'ENPD', value: 10 };
  }

  const nc = m.mce.n;
  const cfgs = Array.from({ length: nc }, (_, i) => i + 1);
  const groups = groupMce(m);
  const used = new Set();
  const grp = (op, i1, i2 = 0) => {
    const k = `${op}|${i1}|${i2}`;
    if (!groups.has(k)) return null;
    used.add(k);
    return groups.get(k);
  };
  // value of an MCE-controlled quantity in every configuration (base value where a row is missing)
  const perCfg = (g, base) => cfgs.map(c => (g && g.rows[c] && !Number.isNaN(g.rows[c].value) ? g.rows[c].value : base));

  const fields = compileFields(m);
  let waves = compileWaves(m, log);
  const nf = fields.length, nw = waves.length;
  if (nf > 25) log.warn(`视场数 ${nf} 超过 CODE V 的上限 25。`, `${nf} fields: more than the 25 CODE V allows.`);
  if (nw > 21) log.warn(`波长数 ${nw} 超过 CODE V 的上限 21。`, `${nw} wavelengths: more than the 21 CODE V allows.`);
  const pwav = Math.min(Math.max(1, m.pwav), nw);
  const primaryUm = waves[pwav - 1].um;

  const table = o.glassTable;
  if (!table) {
    log.warn('没有加载玻璃映射表 CV2ZMX_GLASS.DAT，所有目录玻璃都按模型玻璃（nd/vd）写出。',
      'Glass map CV2ZMX_GLASS.DAT not loaded: every catalog glass was written as a model glass (nd/vd).');
  }

  // ---------------------------------------------------------------- glasses
  const glassReport = [];
  const resolveGlass = (glas, sIdx, where) => {
    if (!glas || !glas.name) return { kind: 'air', tok: '', nd: 1, vd: 0 };
    const name = glas.name.trim();
    const U = name.toUpperCase();
    let r;
    if (U === 'MIRROR') return { kind: 'mirror', tok: 'REFL' };
    if (glas.code === 1 || U === '___BLANK') {
      r = { kind: 'model', tok: modelGlassToken(glas.nd, glas.vd), nd: glas.nd, vd: glas.vd };
      if (glas.dpgf) {
        log.warn(`面 ${sIdx} 的模型玻璃带 ΔPgF=${glas.dpgf}，CODE V 的模型玻璃没有这一项，已丢掉。`,
          `S${sIdx}: model glass dPgF ${glas.dpgf} dropped (CODE V model glass has no dPgF).`);
      }
    } else if (glas.code === 4) {
      const hit = lookupGlass(table, name, m.gcat);
      const nd = glas.nd + glas.dn, vd = glas.vd + glas.dv;
      if (o.offsetGlass === 'model' || !hit) {
        r = { kind: 'offset-model', tok: modelGlassToken(nd, vd), nd, vd };
        log.warn(`面 ${sIdx} 是 Offset 玻璃（${name} ${glas.dn >= 0 ? '+' : ''}${glas.dn} / ${glas.dv >= 0 ? '+' : ''}${glas.dv}），CODE V 没有这个功能，已写成模型玻璃 ${r.tok}（丢掉真实色散曲线）。`,
          `S${sIdx}: offset glass ${name} (dNd ${glas.dn}, dVd ${glas.dv}) written as model glass ${r.tok}.`);
      } else {
        r = { kind: 'offset-base', tok: hit.row.cv, nd, vd, cv: hit.row.cv };
        log.warn(`面 ${sIdx} 是 Offset 玻璃，CODE V 没有这个功能，只写了基准玻璃 ${hit.row.cv}，Nd ${glas.dn >= 0 ? '+' : ''}${glas.dn} / Vd ${glas.dv >= 0 ? '+' : ''}${glas.dv} 的偏移丢了（要保住 nd/vd 就把“Offset 玻璃”选成模型玻璃）。`,
          `S${sIdx}: offset glass written as its base glass ${hit.row.cv}; offsets dNd ${glas.dn} / dVd ${glas.dv} are lost.`);
      }
    } else {
      const hit = lookupGlass(table, name, m.gcat);
      if (hit) {
        r = { kind: 'catalog', tok: hit.row.cv, nd: hit.row.nd, vd: hit.row.vd, cv: hit.row.cv };
        if (!hit.inGcat) {
          log.info(`玻璃 ${name} 不在文件 GCAT 列出的目录里，按映射表取了 ${hit.row.cv}。`,
            `Glass ${name} is not in the GCAT catalogs; mapped to ${hit.row.cv}.`);
        }
      } else {
        // Older OpticStudio versions write the placeholder "1.5 40" instead of the catalog nd/vd.
        const usable = glas.nd > 1 && !(glas.nd === 1.5 && glas.vd === 40);
        if (o.unknownGlass === 'guess' || !usable) {
          const v = m.gcat.map(g => table && vendorOf(table, g)).find(Boolean)
            || (m.gcat[0] || 'SCHOTT').toUpperCase().replace(/[^A-Z]/g, '');
          r = { kind: 'guess', tok: `${normName(name)}_${v}`, nd: glas.nd > 1 ? glas.nd : 1.5, vd: glas.vd > 0 ? glas.vd : 50 };
          log.warn(`玻璃 ${name} 不在映射表里${usable ? '' : '，文件里也没有可用的 nd/vd（缺失或是 1.5/40 占位值）'}，按名字猜成 ${r.tok}。CODE V 目录里没有这个牌号的话，该面会变成空气，请核对。`,
            `Glass ${name} is not in the glass map${usable ? '' : ' and the file has no usable nd/vd'}; guessed ${r.tok}. If CODE V does not know it the surface becomes air.`);
        } else {
          r = { kind: 'unknown', tok: modelGlassToken(glas.nd, glas.vd > 0 ? glas.vd : 50), nd: glas.nd, vd: glas.vd };
          log.warn(`玻璃 ${name} 在映射表里找不到对应的 CODE V 牌号，已按文件里的 nd/vd 写成模型玻璃 ${r.tok}。`,
            `Glass ${name} has no CODE V counterpart in the glass map; written as model glass ${r.tok} from the file's nd/vd.`);
        }
      }
    }
    glassReport.push({ surface: sIdx, where, zemax: name, codev: r.tok, kind: r.kind, nd: r.nd, vd: r.vd });
    return r;
  };

  // ---------------------------------------------------------------- per-surface data
  const surf = S.map((s, i) => {
    const d = { s, i };
    d.thi = perCfg(grp('THIC', i), s.disz);
    d.curv = perCfg(grp('CRVT', i), s.curv);
    d.coni = perCfg(grp('CONN', i), s.coni);
    d.glassG = grp('GLSS', i);
    d.sdia = perCfg(grp('SDIA', i), s.diam ? s.diam.v : 0);
    d.sdiaZoomed = !allEqual(d.sdia);
    return d;
  });
  const stopIdx = Math.max(1, S.findIndex(s => s.stop));
  if (!S.some(s => s.stop)) log.warn('文件里没有标光阑面（STOP），CODE V 默认面 1 是光阑。', 'No STOP surface in the file; CODE V will use surface 1.');

  // glass per surface and configuration
  let medium = { kind: 'air', tok: '', nd: 1, vd: 0 };
  for (const d of surf) {
    const s = d.s;
    if (s.type === 'COORDBRK') { d.glass = cfgs.map(() => medium); d.writeMedium = medium; continue; }
    const base = resolveGlass(s.glas, d.i, 'LDE');
    if (d.glassG) {
      d.glass = cfgs.map(c => {
        const r = d.glassG.rows[c];
        if (!r) return base;
        const nm = r.str.trim();
        if (s.glas && nm.toUpperCase() === s.glas.name.toUpperCase()) return base;
        return resolveGlass({ name: nm, code: 0, nd: NaN, vd: NaN }, d.i, `Z${c}`);
      });
    } else d.glass = cfgs.map(() => base);
    d.writeMedium = d.glass[0];
    if (d.glass[0].kind !== 'mirror') medium = d.glass[0];
  }

  // ---------------------------------------------------------------- surface shapes
  for (const d of surf) d.shape = surfaceShape(d, grp, cfgs, log, primaryUm, mmPerUnit);

  // ---------------------------------------------------------------- paraxial model per configuration
  const parax = cfgs.map((c, ci) => {
    const n = [], cv = [], t = [], doe = [];
    let sign = 1, nAbs = 1;
    surf.forEach((d, i) => {
      const g = d.glass[ci];
      if (g.kind === 'mirror') sign = -sign;
      else if (d.s.type !== 'COORDBRK') nAbs = g.kind === 'air' ? 1 : cauchyIndex(g.nd, g.vd, primaryUm);
      n[i] = sign * nAbs;
      cv[i] = d.curv[ci] + 2 * (d.shape.r2 ? d.shape.r2[ci] : 0);
      t[i] = d.thi[ci];
      doe[i] = d.shape.doePower || 0;
    });
    return { n, cv, t, doe };
  });
  const paraxResults = parax.map((p, ci) => paraxial(p, N, stopIdx, Math.abs(p.t[0]) >= INF_THI));
  const finite = parax.map(p => Math.abs(p.t[0]) < INF_THI);
  if (surf.some(d => d.s.type === 'COORDBRK' && d.shape.decenter && d.shape.decenter.tilted)) {
    log.info('系统里有倾斜的坐标断点，近轴核对只当参考。', 'Tilted coordinate breaks present: the paraxial check is only indicative.');
  }

  // ---------------------------------------------------------------- aperture
  const ap = apertureValues(m, grp, cfgs, paraxResults, finite, surf, stopIdx, log);

  // ---------------------------------------------------------------- fields & vignetting per configuration
  const ftype = m.ftyp ? m.ftyp[0] : 0;
  let fpre;
  if (ftype === 0) fpre = 'AN';
  else if (ftype === 1) fpre = 'OB';
  else if (ftype === 2) fpre = 'IM';
  else if (ftype === 3) fpre = 'RI';
  else {
    fpre = 'AN';
    log.warn(`视场类型 FTYP ${ftype}（经纬仪角等）CODE V 没有直接对应，已按物方角度 XAN/YAN 写出，请核对。`,
      `Field type FTYP ${ftype} has no CODE V equivalent; written as object angles XAN/YAN - check it.`);
  }
  const fz = (op, f, base) => perCfg(grp(op, f), base);
  let F = fields.map((f, k) => {
    const i = k + 1;
    const r = { x: fz('XFIE', i, f.x), y: fz('YFIE', i, f.y), w: fz('FLWT', i, f.w),
      vdx: fz('FVDX', i, f.vdx), vdy: fz('FVDY', i, f.vdy), vcx: fz('FVCX', i, f.vcx), vcy: fz('FVCY', i, f.vcy) };
    r.vux = cfgs.map((_, c) => round12(r.vcx[c] - r.vdx[c]));
    r.vlx = cfgs.map((_, c) => round12(r.vcx[c] + r.vdx[c]));
    r.vuy = cfgs.map((_, c) => round12(r.vcy[c] - r.vdy[c]));
    r.vly = cfgs.map((_, c) => round12(r.vcy[c] + r.vdy[c]));
    if (f.van) log.warn(`视场 ${i} 有渐晕角 VAN=${f.van}°，CODE V 没有对应项，已忽略。`, `Field ${i}: vignetting angle VAN ${f.van} deg ignored (no CODE V equivalent).`);
    r.zemaxIndex = i;
    return r;
  });
  if (o.fieldOrder === 'ascending') {
    const radius = f => Math.hypot(f.x[0], f.y[0]);
    const sorted = [...F].sort((a, b) => radius(a) - radius(b) || a.zemaxIndex - b.zemaxIndex);
    if (sorted.some((f, k) => f !== F[k])) {
      F = sorted;
      log.info(`视场已按 CODE V 习惯从轴上排起（Zemax 视场 ${F.map(f => f.zemaxIndex).join(', ')} → CODE V F1…F${nf}），渐晕跟着一起排。`,
        `Fields reordered on-axis first (Zemax fields ${F.map(f => f.zemaxIndex).join(', ')} -> CODE V F1..F${nf}).`);
    }
  }

  // ---------------------------------------------------------------- wavelengths
  const waveG = waves.map((_, k) => grp('WAVE', k + 1));
  const wtG = waves.map((_, k) => grp('WLWT', k + 1));
  const wavesZoomed = waveG.some(Boolean);
  let order = waves.map((_, k) => k);
  if (o.waveOrder === 'descending' && !wavesZoomed) order.sort((a, b) => waves[b].um - waves[a].um || a - b);
  const newIndex = []; order.forEach((k, j) => { newIndex[k] = j + 1; });
  const W = order.map(k => ({
    um: perCfg(waveG[k], waves[k].um),
    w: perCfg(wtG[k], waves[k].w),
  }));
  const refZ = perCfg(grp('PWAV', 0), pwav).map(v => newIndex[Math.min(Math.max(1, v), nw) - 1]);
  const allW = W.flatMap(x => x.w);
  let wScale = 1;
  for (const sc of [1, 10, 100, 1000, 10000]) {
    wScale = sc;
    if (allW.every(v => Math.abs(v * sc - Math.round(v * sc)) < 1e-9 * Math.max(1, v * sc))) break;
  }
  const wInt = v => Math.round(v * wScale);
  if (wScale > 1) {
    log.info(`波长权重有小数，已统一乘以 ${wScale} 写成整数（只影响相对比例的写法）。`, `Wavelength weights scaled by ${wScale} to integers.`);
  }

  // ---------------------------------------------------------------- title
  let title = (o.title || m.name || (o.fileName || '').replace(/\.[^.]*$/, '') || 'ZMX2SEQ').trim();
  title = title.replace(/'/g, '"');
  if (title.length > 80) title = title.slice(0, 80);

  // ==================================================================== write
  const L = [];
  const put = (key, ...vals) => L.push(vals.length ? key.padEnd(5) + ' ' + vals.join(' ') : key);
  const putList = (head, vals) => { for (const ln of wrapList(head.padEnd(5), vals)) L.push(ln); };
  const attr = s => L.push('  ' + s);
  const attrs = cmds => { for (const ln of packCommands(cmds)) L.push('  ' + ln); };

  const date = o.date ? new Date(o.date) : new Date();
  L.push(`RDM;LEN       "VERSION: 2026       LENS VERSION: 92       Creation Date: ${codevDate(date)}"`);
  const commentAt = L.length;            // header comments are inserted here at the end

  put('TITLE', `'${title}'`);
  put(ap.key, fmtNum(round12(ap.values[0])));
  put('DIM', dim);
  put('WL', ...W.map(w => fmtNum(Math.round(w.um[0] * 1e9) / 1e6)));
  put('REF', String(refZ[0]));
  put('WTW', ...W.map(w => String(wInt(w.w[0]))));
  put('TEM', fmtNum(m.env.temp));
  if (!nearlyEqual(m.env.pres, 1)) put('PRE', fmtNum(round12(m.env.pres * 760)));
  putList('X' + fpre, F.map(f => fmtNum(f.x[0])));
  putList('Y' + fpre, F.map(f => fmtNum(f.y[0])));
  if (fpre === 'AN' && F.some(f => [...f.x, ...f.y].some(v => Math.abs(v) > 90))) put('WID', 'Y');
  putList('WTF', F.map(f => fmtNum(f.w[0])));
  putList('VUX', F.map(f => fmtNum(f.vux[0])));
  putList('VLX', F.map(f => fmtNum(f.vlx[0])));
  putList('VUY', F.map(f => fmtNum(f.vuy[0])));
  putList('VLY', F.map(f => fmtNum(f.vly[0])));

  // ---------------------------------------------------------------- surfaces
  const cirSurfaces = new Set();
  const oalSurfaces = new Set();
  for (const d of surf) {
    const { s, i } = d;
    const key = i === 0 ? 'SO' : (i === N ? 'SI' : 'S');
    const med = (i === N) ? '' : d.writeMedium.tok;
    put(key, radiusOf(d.curv[0]), fmtThi(d.thi[0]) + (med ? ' ' + med : ''));
    if (s.stop && i > 0 && i < N) attr('STO');
    if (s.comm) attr(`SLB "${s.comm.replace(/"/g, "'")}"`);

    const sh = d.shape;
    for (const ln of sh.lines) attr(ln);

    // apertures
    const cmds = [];
    let hasCir = false;
    for (const a of s.apers) {
      if (a.unsupported) {
        log.warn(`面 ${i} 有 ${a.kind} 口径（非圆形/用户定义），没有转换。`, `S${i}: ${a.kind} aperture not converted (only circular apertures are).`);
      } else if (a.kind === 'CLAP') {
        cmds.push(`CIR ${fmtNum(a.max)}`); hasCir = true;
        if (a.min > 0) cmds.push(`CIR OBS ${fmtNum(a.min)}`);
      } else if (a.kind === 'FLAP') {
        cmds.push(`CIR ${fmtNum(d.sdia[0] || a.max)}`); hasCir = true;
      } else if (a.kind === 'OBSC') {
        cmds.push(`CIR OBS ${fmtNum(a.max)}`);
        if (a.min > 0) log.warn(`面 ${i} 的环形遮拦内半径 ${a.min} 没有转换。`, `S${i}: inner radius ${a.min} of the annular obscuration not converted.`);
      }
    }
    const fixedSd = s.diam && (s.diam.flag === 1 || s.diam.flag === 2) && s.diam.v > 0;
    if (!hasCir && i > 0 && i < N && s.type !== 'COORDBRK'
        && ((o.sd === 'fixed' && fixedSd) || (o.sd === 'all' && s.diam && s.diam.v > 0))) {
      cmds.push(`CIR ${fmtNum(d.sdia[0])}`); hasCir = true;
    }
    if (hasCir) cirSurfaces.add(i);
    if (s.aperDec && (s.aperDec.x || s.aperDec.y) && cmds.length) {
      cmds.push(`ADX ${fmtNum(s.aperDec.x)}`, `ADY ${fmtNum(s.aperDec.y)}`);
      log.warn(`面 ${i} 的口径偏心已写成 ADX/ADY，请在 CODE V 里核对。`, `S${i}: aperture decenter written as ADX/ADY - check it.`);
    }
    for (const c of cmds) attr(c);
    if (s.tilt) log.warn(`面 ${i} 自带倾斜/偏心（Tilt/Decenter 页），没有转换。`, `S${i}: surface tilt/decenter not converted.`);
    for (const k of s.solves) {
      log.info(`面 ${i} 的厚度求解（${THICKNESS_SOLVES[k]}）按当前值写出，CODE V 里不会跟着变。`, `S${i}: ${THICKNESS_SOLVES[k]} thickness solve written as its current value.`);
    }
  }

  // ---------------------------------------------------------------- position solves
  for (const d of surf) {
    const { s, i } = d;
    if (!s.tole) continue;
    const from = s.tole.from;
    if (!o.oal) {
      log.info(`面 ${i} 的位置求解按当前厚度写出（没有写 OAL）。`, `S${i}: position solve written as its current thickness (OAL disabled).`);
    } else if (from >= 0 && from <= i && i < N) {
      put('THI', `S${i} OAL S${from}..${i + 1} ${fmtNum(s.tole.len)}`);
      oalSurfaces.add(i);
    } else {
      log.warn(`面 ${i} 的位置求解参考面 ${from} 在它后面，没有转换，按当前厚度写出。`, `S${i}: position solve referenced to a later surface (${from}) not converted.`);
    }
  }

  // ---------------------------------------------------------------- zoom
  if (nc > 1) {
    put('ZOO', String(nc));
    const ltt = grp('LTTL', 0);
    if (ltt) {
      put('ZOO', 'TIT');
      for (const c of cfgs) {
        const tt = (ltt.rows[c] ? ltt.rows[c].str : '').replace(/"/g, "'");
        put('TIT', `Z${c} "${tt}"`);
      }
    }
    const zoo = (what, vals) => { if (!allEqual(vals.map(String))) putList(`ZOO   ${what}`, vals); };
    zoo(ap.key, ap.values.map(v => fmtNum(round12(v))));
    zoo('REF', refZ.map(String));
    W.forEach((w, j) => {
      zoo(`WL W${j + 1}`, w.um.map(v => fmtNum(Math.round(v * 1e9) / 1e6)));
      zoo(`WTW W${j + 1}`, w.w.map(v => String(wInt(v))));
    });
    F.forEach((f, k) => {
      const i = k + 1;
      zoo(`X${fpre} F${i}`, f.x.map(fmtNum));
      zoo(`Y${fpre} F${i}`, f.y.map(fmtNum));
      zoo(`WTF F${i}`, f.w.map(fmtNum));
    });
    for (const [a, b] of [['vuy', 'vly'], ['vux', 'vlx']]) {
      F.forEach((f, k) => {
        if (allEqual(f[a]) && allEqual(f[b])) return;
        putList(`ZOO   ${a.toUpperCase()} F${k + 1}`, f[a].map(fmtNum));
        putList(`ZOO   ${b.toUpperCase()} F${k + 1}`, f[b].map(fmtNum));
      });
    }
    if (grp('TEMP', 0)) zoo('TEM', perCfg(grp('TEMP', 0), m.env.temp).map(fmtNum));
    if (grp('PRES', 0)) zoo('PRE', perCfg(grp('PRES', 0), m.env.pres).map(v => fmtNum(round12(v * 760))));

    for (const d of surf) {
      const { s, i } = d;
      const sn = `S${i}`;
      const tg = groups.get(`THIC|${i}|0`);
      if (tg && !allEqual(d.thi)) {
        if (oalSurfaces.has(i)) {
          log.warn(`面 ${i} 同时有位置求解和多重结构厚度，按求解处理，没有写 ZOO THI（两者同时写会让求解失效）。`,
            `S${i}: has both a position solve and MCE thicknesses; kept the solve and skipped ZOO THI.`);
        } else {
          putList(`ZOO   THI ${sn}`, d.thi.map(fmtThi));
          const codes = cfgs.map(c => (o.zoomVars && tg.rows[c] && tg.rows[c].status === 1 ? '0' : '100'));
          L.push(`ZOO THC ${sn} ${codes.join(' ')}`);
        }
      }
      if (!allEqual(d.curv)) putList(`ZOO   CUY ${sn}`, d.curv.map(fmtNum));
      if (!allEqual(d.coni)) {
        if (d.shape.kind === 'SPS') log.warn(`面 ${i} 是 SPS ODD 面，圆锥系数的多重结构没有转换。`, `S${i}: zoomed conic on an SPS ODD surface not converted.`);
        else putList(`ZOO   K ${sn}`, d.coni.map(fmtNum));
      }
      for (const [letter, vals] of d.shape.zoomCoefs) putList(`ZOO   ${letter} ${sn}`, vals.map(fmtNum));
      for (const [what, vals] of d.shape.zoomDecenter) putList(`ZOO   ${what} ${sn}`, vals.map(fmtNum));
      if (d.sdiaZoomed) {
        if (cirSurfaces.has(i)) putList(`ZOO   CIR ${sn}`, d.sdia.map(fmtNum));
        else log.info(`面 ${i} 的半口径随结构变，但它不是挡光口径，没有写 ZOO CIR。`, `S${i}: zoomed semi-diameter is not a clear aperture here; not written.`);
      }
      if (d.glassG && !allEqual(d.glass.map(g => g.tok))) putList(`ZOO   GLA ${sn}`, d.glass.map(g => g.tok || 'AIR'));
    }
    const handled = new Set(['LTTL', 'THIC', 'CRVT', 'CONN', 'GLSS', 'SDIA', 'APER', 'XFIE', 'YFIE', 'FLWT',
      'FVDX', 'FVDY', 'FVCX', 'FVCY', 'WAVE', 'WLWT', 'PWAV', 'TEMP', 'PRES', 'MOFF']);
    const skipped = new Map();
    for (const [k, g] of groups) {
      if (used.has(k) || handled.has(g.op)) continue;
      const vals = cfgs.map(c => g.rows[c]?.value);
      if (allEqual(vals.map(String))) continue;
      skipped.set(g.op, (skipped.get(g.op) || 0) + 1);
    }
    for (const [op, n] of skipped) {
      log.warn(`多重结构操作数 ${op}（${n} 行）没有对应的 CODE V 写法，没有转换。`, `MCE operand ${op} (${n} row(s)) not converted.`);
    }
  } else if (m.mce.rows.some(r => r.op !== 'MOFF')) {
    log.info('多重结构只有 1 个结构，按单结构写出。', 'Only one configuration: written without zoom.');
  }
  L.push('GO');

  // ---------------------------------------------------------------- report
  const infoParax = paraxResults.map((p, ci) => ({
    cfg: ci + 1,
    title: grp('LTTL', 0)?.rows[ci + 1]?.str || '',
    efl: p.efl, bfl: p.bfl, defocus: p.defocus, beta: p.beta, finite: finite[ci],
    aperture: ap.values[ci], apertureKey: ap.key,
  }));
  if (/[^\x00-\x7f]/.test(L.join('\n'))) {
    log.info('标题或标签里有中文等非 ASCII 字符，默认按 GBK 编码保存（和 CV2ZMX.seq 一样）。',
      'Title or labels contain non-ASCII characters; saved as GBK by default.');
  }
  if (o.comments) {
    const C = [];
    C.push(`! Converted from ${o.fileName || 'a .zmx file'} by zmx2seq ${VERSION} (https://github.com/anvcor/cv2zmx)`);
    C.push(`! ${N - 1} surfaces, ${nf} field(s), ${nw} wavelength(s), ${nc} configuration(s)`);
    C.push('! Paraxial check (indices estimated from nd/vd at the primary wavelength):');
    for (const p of infoParax) {
      const parts = [`Z${p.cfg}`, `EFL ${fmtShort(p.efl)}`, `BFL ${fmtShort(p.bfl)}`];
      if (p.finite) parts.push(`mag ${fmtShort(p.beta)}`);
      C.push(`!   ${parts.join('  ')}`);
    }
    for (const w of log.items.filter(x => x.level === 'warn')) C.push(`! WARNING: ${w.en}`);
    L.splice(commentAt, 0, ...C);
  }
  const seq = L.join('\r\n') + '\r\n';

  // prescription table and drawing data (first configuration)
  const surfaceTable = surf.map(d => ({
    i: d.i, type: d.s.type, label: d.s.comm, stop: d.s.stop,
    radius: radiusOf(d.curv[0]), thickness: d.thi[0],
    zemaxGlass: d.s.glas ? d.s.glas.name : '', codevGlass: d.i === N ? '' : d.writeMedium.tok,
    sd: d.sdia[0], cir: cirSurfaces.has(d.i), shape: d.shape.kind,
  }));
  const drawable = N >= 2 && surf.every(d => d.s.type !== 'COORDBRK' && d.glass[0].kind !== 'mirror')
    && surf.slice(1, N).every(d => Math.abs(d.thi[0]) < INF_THI);
  let z = 0;
  const layout = drawable ? surf.slice(1).map(d => {
    const e = { i: d.i, z, c: d.curv[0], k: d.coni[0], poly: d.shape.poly || [], sd: d.sdia[0],
      glass: d.i < N && d.glass[0].kind !== 'air', stop: d.s.stop, image: d.i === N };
    z += d.thi[0];
    return e;
  }) : null;

  return {
    seq,
    warnings: log.items,
    info: {
      title, unit: m.unit, surfaces: N - 1, fields: nf, wavelengths: nw, configurations: nc,
      fieldType: 'X' + fpre + '/Y' + fpre, aperture: ap, glasses: glassReport, paraxial: infoParax,
      gcat: m.gcat, zemaxVersion: m.version, surfaceTable, layout,
    },
  };
}

function fmtShort(v) {
  if (!Number.isFinite(v)) return 'inf';
  return Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(5) : v.toFixed(5);
}

// ======================================================================
// Surface shapes
// ======================================================================

function surfaceShape(d, grp, cfgs, log, primaryUm, mmPerUnit) {
  const { s, i } = d;
  const sh = { kind: 'SPH', lines: [], zoomCoefs: [], zoomDecenter: [], r2: null, doePower: 0, decenter: null };
  const k0 = d.coni[0];
  const kZoomed = !allEqual(d.coni);
  const T = s.type;
  // coefficient of r^p, possibly per configuration
  const coefs = new Map();                       // power → number[] (per config)
  const setCoef = (p, vals) => { if (vals.some(v => v !== 0)) coefs.set(p, vals); };
  const zoomOf = (op, i2, base) => {
    const g = grp(op, i, i2);
    return cfgs.map(c => (g && g.rows[c] && !Number.isNaN(g.rows[c].value) ? g.rows[c].value : base));
  };

  if (T === 'STANDARD' || T === 'COORDBRK') {
    // handled below
  } else if (T === 'EVENASPH' || T === 'BINARY_2') {
    for (let p = 1; p <= 8; p++) setCoef(2 * p, zoomOf('PRAM', p, s.parm[p] || 0));
  } else if (T === 'XASPHERE' || T === 'XOSPHERE') {
    const nTerm = s.xdat[1] || 0;
    let rn = s.xdat[2] || 1;
    if (!s.xdat[2]) log.warn(`面 ${i} 的归一化半径是 0，按 1 处理。`, `S${i}: normalization radius 0 treated as 1.`);
    const odd = T === 'XOSPHERE';
    for (let k = 1; k <= nTerm; k++) {
      const p = odd ? k : 2 * k;
      setCoef(p, zoomOf('EDVA', k + 2, s.xdat[k + 2] || 0).map(v => v / Math.pow(rn, p)));
    }
  } else if (T === 'ODDASPH') {
    for (let p = 1; p <= 8; p++) setCoef(p, zoomOf('PRAM', p, s.parm[p] || 0));
  } else {
    const what = { PARAXIAL: '理想透镜面（Paraxial）', TOROIDAL: '环形面', BICONICX: '双锥面', BICONIC: '双锥面',
      CYLINDER: '柱面', QED_TYPE: 'Q 型非球面', SZERNSAG: 'Zernike 面', GRID_SAG: '网格面' }[T] || T;
    log.warn(`面 ${i} 的面型 ${T}（${what}）不支持，只按基础曲率${k0 ? '和圆锥系数' : ''}写出，请手工补。`,
      `S${i}: surface type ${T} not supported; written with its base curvature${k0 ? ' and conic' : ''} only.`);
  }

  // DOE (Binary 2): phase = M Σ A_j ρ^(2j) radians → CODE V OPD coefficients in lens units at HWL
  if (T === 'BINARY_2') {
    const M = s.parm[0] || 0;
    const nTerm = s.xdat[1] || 0, rn = s.xdat[2] || 1;
    const lam = primaryUm * 1e-3 / mmPerUnit;                   // primary wavelength in lens units
    const hco = [];
    for (let j = 1; j <= nTerm; j++) {
      const A = s.xdat[j + 2] || 0;
      if (A) hco.push(`HCO C${j} ${fmtNum(A * lam / (2 * Math.PI) / Math.pow(rn, 2 * j))}`);
    }
    if (M && hco.length) {
      const A1 = s.xdat[3] || 0;
      sh.doePower = -M * lam * 2 * A1 / (2 * Math.PI * rn * rn);
      sh.doeLines = ['DIF DOE', `HOR ${fmtNum(M)}`, `HWL ${fmtNum(Math.round(primaryUm * 1e9) / 1e6)}; HCT R`, ...hco];
      log.warn(`面 ${i} 是衍射面（Binary 2），已写成 CODE V 的 DIF DOE（HCO = A·λ0/2π），请在 CODE V 里核对焦距。`,
        `S${i}: Binary 2 diffractive surface written as DIF DOE (HCO = A*lambda0/2pi) - check EFL in CODE V.`);
    }
  }
  if (T === 'PARAXIAL' && s.parm[1]) sh.doePower = 1 / s.parm[1];    // keeps the paraxial check meaningful

  // r^2 term → paraxial curvature contribution; tracked per configuration
  if (coefs.has(2)) sh.r2 = coefs.get(2);
  sh.poly = [...coefs].map(([p, v]) => [p, v[0]]);          // first configuration, for drawing
  const powers = [...coefs.keys()];
  const needSps = powers.some(p => p % 2 || p === 2 || p > 20);
  const anyAsp = powers.length > 0;

  if (T === 'COORDBRK') {
    sh.kind = 'CB';
    const dx = zoomOf('PRAM', 1, s.parm[1] || 0), dy = zoomOf('PRAM', 2, s.parm[2] || 0);
    const ax = zoomOf('PRAM', 3, s.parm[3] || 0), by = zoomOf('PRAM', 4, s.parm[4] || 0), cz = zoomOf('PRAM', 5, s.parm[5] || 0);
    const order = s.parm[6] || 0;
    const tilted = [ax, by, cz].some(a => a.some(v => v !== 0));
    const shifted = [dx, dy].some(a => a.some(v => v !== 0));
    sh.decenter = { tilted };
    if (tilted || shifted) {
      const nTilts = [ax, by, cz].filter(a => a.some(v => v !== 0)).length;
      if (order && shifted && tilted) {
        log.warn(`面 ${i} 是先倾斜后偏心（order=1）的坐标断点，CODE V 的基本偏心是先偏心后倾斜，没有转换。`,
          `S${i}: coordinate break with order 1 (tilt before decenter) and both terms set - not converted.`);
        return sh;
      }
      if (order && nTilts > 1) {
        log.warn(`面 ${i} 是 order=1 的多轴倾斜坐标断点，转动顺序和 CODE V 不同，没有转换。`,
          `S${i}: coordinate break with order 1 and several tilts - rotation order differs from CODE V, not converted.`);
        return sh;
      }
      sh.lines.push(`XDE ${fmtNum(dx[0])}; YDE ${fmtNum(dy[0])}; ZDE 0.0`);
      if (tilted) sh.lines.push(`ADE ${fmtNum(ax[0])}; BDE ${fmtNum(by[0])}; CDE ${fmtNum(cz[0])}`);
      for (const [w, v] of [['XDE', dx], ['YDE', dy], ['ADE', ax], ['BDE', by], ['CDE', cz]]) {
        if (!allEqual(v)) sh.zoomDecenter.push([w, v]);
      }
      log.warn(`面 ${i} 的坐标断点已写成 CODE V 基本偏心（XDE/YDE、ADE/BDE/CDE），倾斜方向请在 CODE V 里画图核对。`,
        `S${i}: coordinate break written as a basic decenter (XDE/YDE, ADE/BDE/CDE) - check tilt directions in CODE V.`);
    }
    return sh;
  }

  if (needSps) {
    sh.kind = 'SPS';
    sh.lines.push('SPS ODD 0.0', `SCO C1 ${fmtNum(k0)}`);
    for (const p of powers.sort((a, b) => a - b)) {
      if (p > 30) {
        log.warn(`面 ${i} 的 r^${p} 项超出 CODE V SPS ODD 的范围（到 r^30），已丢掉。`, `S${i}: r^${p} term beyond SPS ODD range (r^30) dropped.`);
        continue;
      }
      sh.lines.push(`SCO C${p + 1} ${fmtNum(coefs.get(p)[0])}`);
      if (!allEqual(coefs.get(p))) log.warn(`面 ${i} 的 SPS 系数随结构变化，没有转换。`, `S${i}: zoomed SPS coefficient not converted.`);
    }
    const why = powers.includes(2) ? 'r² 项' : (powers.some(p => p % 2) ? '奇次项' : 'r²⁰ 以上的高次项');
    log.warn(`面 ${i} 有${why}，CODE V 的 ASP 放不下，已写成 SPS ODD（C1 = K，C(n+1) = r^n），请在 CODE V 里核对。`,
      `S${i}: ${powers.includes(2) ? 'r^2' : (powers.some(p => p % 2) ? 'odd' : 'beyond r^20')} terms do not fit ASP; written as SPS ODD (C1 = K, C(n+1) = r^n) - check it.`);
  } else if (anyAsp || T === 'EVENASPH' || T === 'XASPHERE' || T === 'BINARY_2') {
    if (anyAsp) {
      sh.kind = 'ASP';
      sh.lines.push('ASP', `K   ${fmtNum(k0)}`, 'CUF 0.0');
      const last = Math.max(...powers);
      const groupsP = last <= 10 ? [[4, 6, 8, 10]] : [[4, 6, 8, 10], [12, 14, 16, 18], [20]];
      for (const gp of groupsP) {
        const cmds = gp.map(p => `${ASP_LETTERS[p]} ${fmtNum(coefs.has(p) ? coefs.get(p)[0] : 0)}`);
        for (const ln of packCommands(cmds)) sh.lines.push(ln);
      }
      for (const p of powers) {
        if (!allEqual(coefs.get(p))) sh.zoomCoefs.push([ASP_LETTERS[p], coefs.get(p)]);
      }
    } else if (k0 !== 0 || kZoomed) {
      sh.kind = 'CON';
      sh.lines.push('CON', `K   ${fmtNum(k0)}`);
    }
  } else if (k0 !== 0 || kZoomed) {
    sh.kind = 'CON';
    sh.lines.push('CON', `K   ${fmtNum(k0)}`);
  }
  if (sh.doeLines) sh.lines.push(...sh.doeLines);
  return sh;
}

// ======================================================================
// Paraxial trace (y-nu), used for the aperture conversion and the report
// ======================================================================

function traceRay(p, N, y, nu) {
  const ys = [], nus = [];
  let n = p.n[0];
  for (let i = 1; i < N; i++) {
    const n2 = p.n[i];
    nu = nu - y * (p.cv[i] * (n2 - n) + p.doe[i]);
    n = n2;
    ys[i] = y; nus[i] = nu;
    if (i < N - 1) y = y + p.t[i] * nu / n;
  }
  return { ys, nus, nLast: n, yLast: ys[N - 1], nuLast: nus[N - 1] };
}

function paraxial(p, N, stopIdx, infinite) {
  const out = { efl: NaN, bfl: NaN, defocus: NaN, beta: 0, yStop: NaN, uObj: 0 };
  if (N < 2) return out;
  const r = traceRay(p, N, 1, 0);
  const power = -r.nuLast;
  out.efl = power === 0 ? Infinity : 1 / power;
  const u = r.nuLast / r.nLast;
  const lp = u === 0 ? Infinity : -r.yLast / u;
  if (infinite) {
    out.bfl = lp;
    out.defocus = p.t[N - 1] - lp;
    out.yStop = r.ys[stopIdx];
  } else {
    const u0 = 1e-3, n0 = p.n[0];
    const f = traceRay(p, N, p.t[0] * u0, n0 * u0);
    const uf = f.nuLast / f.nLast;
    out.bfl = uf === 0 ? Infinity : -f.yLast / uf;
    out.defocus = p.t[N - 1] - out.bfl;
    out.beta = (n0 * u0) / f.nuLast;
    out.yStop = f.ys[stopIdx] / u0;          // stop height per unit object-space slope
    out.n0 = n0;
  }
  return out;
}

// ======================================================================
// System aperture
// ======================================================================

function apertureValues(m, grp, cfgs, px, finite, surf, stopIdx, log) {
  const a = m.aperture;
  const g = grp('APER', 0);
  const vals = cfgs.map(c => (g && g.rows[c] && !Number.isNaN(g.rows[c].value) ? g.rows[c].value : a.value));
  const anyFinite = finite.some(Boolean);
  switch (a.type) {
    case 'ENPD':
      return { key: 'EPD', values: vals, type: a.type };
    case 'PWFN': {
      // CODE V FNO is the paraxial working F/# with the object-space NA defined by sin, Zemax uses tan:
      // same entrance pupil ⇔ FNO_CV² = PWFN² + (β/2)²   (patent-lens-to-excel make_seq.py, verified in OpticStudio)
      const out = vals.map((v, k) => (finite[k] ? Math.sqrt(v * v + (px[k].beta / 2) ** 2) : v));
      if (anyFinite) {
        log.info('孔径是近轴工作 F/#，有限共轭结构已按 FNO² = PWFN² + (β/2)² 换算成 CODE V 的 FNO（两边入瞳相同）。',
          'Paraxial working F/#: finite-conjugate positions converted with FNO^2 = PWFN^2 + (beta/2)^2 so the entrance pupil matches.');
      }
      return { key: 'FNO', values: out, type: a.type };
    }
    case 'ISFN':
      if (!anyFinite) return { key: 'FNO', values: vals, type: a.type };
      log.warn('孔径是像方空间 F/#（按无限远共轭定义），文件里有有限共轭结构，CODE V 的 FNO 定义不同，已换算成入瞳直径 EPD = EFL / F#。',
        'Image space F/# with a finite conjugate: converted to EPD = EFL / F# because CODE V FNO is a working F/#.');
      return { key: 'EPD', values: vals.map((v, k) => px[k].efl / v), type: a.type };
    case 'OBNA':
      return { key: 'NAO', values: vals, type: a.type };
    case 'CONE':
      log.warn('孔径是物方锥角，已换算成 NAO = n·sin(θ)。', 'Object cone angle converted to NAO = n sin(theta).');
      return { key: 'NAO', values: vals.map((v, k) => Math.abs(px[k].n0 || 1) * Math.sin(v * Math.PI / 180)), type: a.type };
    case 'FLOA': {
      const sd = surf[stopIdx].sdia;
      log.warn('孔径是“按光阑尺寸浮动”，已按光阑半口径做近轴追迹换算成 EPD / NAO，请核对。',
        'Float-by-stop-size aperture converted from the stop semi-diameter by a paraxial trace - check it.');
      if (!anyFinite) return { key: 'EPD', values: cfgs.map((_, k) => 2 * sd[k] / Math.abs(px[k].yStop)), type: a.type };
      return {
        key: 'NAO', type: a.type,
        values: cfgs.map((_, k) => Math.abs(px[k].n0 || 1) * Math.sin(Math.atan(sd[k] / Math.abs(px[k].yStop)))),
      };
    }
    default:
      throw new ConversionError(`未知的孔径类型 ${a.type}。`, `Unknown aperture type ${a.type}.`);
  }
}

// ======================================================================
// Line formatting
// ======================================================================

/** "KEY  v1 v2 ..." wrapped with CODE V's '&' continuation (next line starts with a blank). */
function wrapList(head, vals, width = 76) {
  const out = [];
  let cur = head;
  let first = true;
  for (const v of vals) {
    if (!first && cur.length + 1 + v.length > width) { out.push(cur + '&'); cur = ' ' + v; }
    else cur += ' ' + v;
    first = false;
  }
  out.push(cur);
  return out;
}

/** Join commands with "; " while the line stays within `width`. */
function packCommands(cmds, width = 76) {
  const out = [];
  let cur = '';
  for (const c of cmds) {
    if (cur && cur.length + 2 + c.length > width) { out.push(cur); cur = c; }
    else cur = cur ? `${cur}; ${c}` : c;
  }
  if (cur) out.push(cur);
  return out;
}
