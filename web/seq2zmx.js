/*
 * seq2zmx.js — CODE V sequence file (.seq) → Zemax OpticStudio .zmx
 *
 * The browser counterpart of CV2ZMX.seq: the macro reads the lens from CODE V's
 * database, this file reads it from a .seq file. The .zmx is written in the layout the
 * macro writes (tested in OpticStudio), and every mapping is the inverse of
 * zmx2seq.js, so a lens can go round trip:
 *   DIM M/C/I                → UNIT MM/CM/IN
 *   EPD / FNO / NAO / NA     → ENPD / FNUM v 1 (paraxial working F/#) / OBNA
 *       finite conjugates: PWFN = sqrt(FNO² − (β/2)²)  (CODE V uses sin, Zemax tan)
 *   XAN YAN / XOB / XIM / XRI → FTYP 0 / 1 / 2 / 3
 *   VUY VLY VUX VLX          → VCY = (VUY+VLY)/2, VDY = (VLY−VUY)/2, X the same
 *   WL nm, WTW, REF          → WAVM µm, PWAV;  TEM / PRE → ENVD
 *   CON + K                  → STANDARD + CONI
 *   ASP A..G / A..J          → EVENASPH PARM 2..8 / XASPHERE XDAT 4..12 (H or J used)
 *   SPS ODD                  → XASPHERE / XOSPHERE
 *   DIF DOE                  → BINARY_2 (XDAT 2+j = 2π/λ0 · Cj)
 *   dummy surface + XDE..CDE → COORDBRK
 *   glass NAME_CAT           → Zemax name and catalog through CV2ZMX_GLASS.DAT
 *   model glass nnn.vvv      → GLAS ___BLANK 1 0 nd vd;   REFL → MIRROR
 *   CIR / CIR OBS / ADX ADY  → DIAM fixed + CLAP / OBSC / OBDC
 *   THI Sk OAL Sj..k+1 len   → TOLE j len
 *   ZOO …                    → MNUM + multi-configuration rows
 * Anything that cannot be carried over is reported and written as NOTE lines.
 */

import { decodeBytes, convertZmx, ConversionError } from './zmx2seq.js';

export const VERSION = '1.0.0';

const INF_THI = 1e10;
const ASP = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'];          // r^4 … r^20
const DEC = ['XDE', 'YDE', 'ZDE', 'ADE', 'BDE', 'CDE'];
const FIELD_TYPES = { AN: 0, OB: 1, IM: 2, RI: 3 };
const MM_PER_UNIT = { M: 1, C: 10, I: 25.4 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const QUAL = /^(S\d+|SO|SI|F\d+|W\d+|Z\d+)$/i;
const IGNORED = new Set(['INI', 'DOR', 'POL', 'CA', 'UID', 'DER', 'CLS', 'CSO', 'GO', 'CUF', 'SCC', 'HCC',
  'CCY', 'CCX', 'THC', 'GLC', 'KC', 'AC', 'BC', 'CC', 'DC', 'EC', 'FC', 'GC', 'HC', 'JC', 'PIM', 'RDC',
  'PWL', 'END', 'EDG', 'SPH']);
const TOLERANCE = new Set(['CMP', 'DSX', 'DSY', 'DSZ', 'BTX', 'BTY', 'BTZ', 'TRX', 'TRY', 'TRZ', 'TOL', 'TIR', 'TFR']);

class Log {
  constructor() { this.items = []; }
  add(level, zh, en) { if (!this.items.some(i => i.en === en)) this.items.push({ level, zh, en }); }
  warn(zh, en) { this.add('warn', zh, en); }
  info(zh, en) { this.add('info', zh, en); }
}

// ======================================================================
// Tokenizing CODE V commands
// ======================================================================

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; } else if (ch === "'" || ch === '"') q = ch; else if (ch === '!') return line.slice(0, i);
  }
  return line;
}

function splitSemicolons(line) {
  const parts = [];
  let q = null, start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; } else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ';') { parts.push(line.slice(start, i)); start = i + 1; }
  }
  parts.push(line.slice(start));
  return parts;
}

/** .seq text → [{ name, args, raw, line }]: comments removed, '&' continuations joined,
 *  ';' separated commands split. */
export function seqCommands(text) {
  const out = [];
  let buf = null, first = 0;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const emit = (t, n) => {
    for (const part of splitSemicolons(t)) {
      const s = part.trim();
      if (!s) continue;
      const toks = s.match(/'[^']*'|"[^"]*"|[^\s,]+/g) || [];
      out.push({ name: toks[0].toUpperCase(), args: toks.slice(1), raw: s, line: n });
    }
  };
  lines.forEach((raw, i) => {
    let t = stripComment(raw).replace(/\s+$/, '');
    if (buf !== null) t = buf + ' ' + t.trim(); else first = i + 1;
    if (t.endsWith('&')) { buf = t.slice(0, -1); return; }
    buf = null;
    emit(t, first);
  });
  if (buf !== null) emit(buf, first);
  return out;
}

const unquote = t => String(t ?? '').trim().replace(/^['"]+/, '').replace(/['"]+$/, '');
const num = (t, d = NaN) => { const v = parseFloat(t); return Number.isFinite(v) ? v : d; };

/** CODE V model glass: "516800.6417" / "517.642" (digits = nd−1, fraction = vd/100) or "nd:vd". */
export function decodeModelGlass(tok) {
  const t = unquote(tok);
  let m = t.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?):([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i);
  if (m) return { nd: +m[1], vd: +m[2] };
  m = t.match(/^(\d+)\.(\d+)$/);
  if (m) return { nd: parseFloat('1.' + m[1]), vd: parseFloat(m[2].padEnd(2, '0').replace(/^(..)/, '$1.')) };  // parsed as decimals: 58.1, not 58.099999…
  return null;
}

// ======================================================================
// .seq → lens model
// ======================================================================

function newSurface(kind) {
  return { kind, curv: 0, thi: 0, glass: null, refl: false, stop: false, label: '', shape: 'SPH', k: 0,
    coef: {}, sps: null, doe: null, cir: null, cirObs: null, adx: 0, ady: 0, dec: null, decType: 'BAS',
    oal: null, apertureNotes: [] };
}

export function parseSeq(text, log = new Log()) {
  const L = {
    title: '', rdm: 'N', dim: 'M',          // CODE V reads curvatures unless RDM (= RDM Y) is given
    aperture: null, wl: null, wtw: null, ref: null, wid: false,
    ftype: null, fld: { X: [], Y: [], WTF: [], VUX: [], VLX: [], VUY: [], VLY: [] },
    tem: null, pre: null, surfaces: [], nz: 1, zoom: new Map(), titles: [], prv: new Map(),
    unknown: new Set(), pickups: 0, tolerances: 0,
  };
  let cur = null, inPrv = false, prvWl = [];

  const surfaceOf = q => {
    if (!q) return cur;
    const u = q.toUpperCase();
    if (u === 'SO') return L.surfaces[0] || null;
    if (u === 'SI') return L.surfaces[L.surfaces.length - 1] || null;
    return L.surfaces[parseInt(u.slice(1), 10)] || null;
  };
  const zoomSet = (key, z, values) => {
    if (!L.zoom.has(key)) L.zoom.set(key, []);
    L.zoom.get(key)[z - 1] = values[0];
  };

  for (const c of seqCommands(text)) {
    const name = c.name;
    if (inPrv) {                                         // private glass catalog
      if (name === 'END') inPrv = false;
      else if (name === 'PWL') prvWl = c.args.map(x => num(x));
      else if (/^['"]/.test(name)) L.prv.set(unquote(c.raw.match(/^('[^']*'|"[^"]*")/)[0]).toUpperCase(), { wl: prvWl, args: c.args });
      continue;
    }
    // leading qualifiers (S5, F2, W1, Z3 …)
    const quals = [];
    let k = 0;
    while (k < c.args.length && QUAL.test(c.args[k])) quals.push(c.args[k++].toUpperCase());
    const rest = c.args.slice(k);
    const sq = quals.find(q => q[0] === 'S'), fq = quals.find(q => q[0] === 'F');
    const wq = quals.find(q => q[0] === 'W'), zq = quals.find(q => q[0] === 'Z');

    if (zq && name !== 'ZOO') {                          // value for one zoom position
      const key = `${name === 'TITLE' ? 'TIT' : name}|${[sq, fq, wq].filter(Boolean).join(' ')}`;
      if (name === 'TIT' || name === 'TITLE') L.titles[parseInt(zq.slice(1), 10) - 1] = unquote(c.raw.replace(/^\S+\s+\S+\s*/, ''));
      else zoomSet(key, parseInt(zq.slice(1), 10), rest);
      continue;
    }

    switch (name) {
      case 'RDM': L.rdm = /^N/i.test(rest[0] || 'Y') ? 'N' : 'Y'; break;
      case 'LEN': if (L.surfaces.length) log.warn('文件里有多个 LEN（多个镜头），只转换了最后一个。', 'Several LEN commands: only the last lens is converted.'); if (L.surfaces.length) L.surfaces = []; cur = null; break;
      case 'TIT': case 'TITLE': L.title = unquote(c.raw.replace(/^\S+\s*/, '')); break;
      case 'DIM': L.dim = (rest[0] || 'M')[0].toUpperCase(); break;
      case 'EPD': case 'FNO': case 'NAO': case 'NA': L.aperture = { type: name, value: num(rest[0]) }; break;
      case 'WL': if (wq) { L.wl = L.wl || []; L.wl[parseInt(wq.slice(1), 10) - 1] = num(rest[0]); } else L.wl = rest.map(x => num(x)); break;
      case 'WTW': if (wq) { L.wtw = L.wtw || []; L.wtw[parseInt(wq.slice(1), 10) - 1] = num(rest[0]); } else L.wtw = rest.map(x => num(x)); break;
      case 'REF': L.ref = parseInt(rest[0], 10); break;
      case 'XAN': case 'YAN': case 'XOB': case 'YOB': case 'XIM': case 'YIM': case 'XRI': case 'YRI': {
        const type = name.slice(1);
        if (L.ftype && L.ftype !== type) log.warn(`文件里同时有 ${L.ftype} 和 ${type} 两种视场，按 ${type} 处理。`, `Both ${L.ftype} and ${type} fields given; used ${type}.`);
        L.ftype = type;
        const arr = L.fld[name[0]];
        if (fq) arr[parseInt(fq.slice(1), 10) - 1] = num(rest[0]);
        else L.fld[name[0]] = rest.map(x => num(x));
        break;
      }
      case 'WTF': case 'VUX': case 'VLX': case 'VUY': case 'VLY':
        if (fq) L.fld[name][parseInt(fq.slice(1), 10) - 1] = num(rest[0]);
        else L.fld[name] = rest.map(x => num(x));
        break;
      case 'WID': L.wid = !/^N/i.test(rest[0] || 'Y'); break;
      case 'TEM': L.tem = num(rest[0]); break;
      case 'PRE': L.pre = num(rest[0]); break;

      case 'SO': case 'S': case 'SI': {
        if (name === 'SO') { L.surfaces = []; }
        const s = newSurface(name);
        const v = num(rest[0], 0);
        s.curv = L.rdm === 'N' ? v : (v ? 1 / v : 0);
        s.thi = num(rest[1], 0);
        for (const g of rest.slice(2)) {
          if (/^REFL$/i.test(g)) s.refl = true; else if (!s.glass) s.glass = g;
        }
        L.surfaces.push(s);
        cur = s;
        break;
      }
      case 'STO': { const t = surfaceOf(sq); if (t) { L.surfaces.forEach(x => { x.stop = false; }); t.stop = true; } break; }
      case 'SLB': { const t = surfaceOf(sq); if (t) t.label = unquote(rest.join(' ')); break; }
      case 'CON': case 'ASP': { const t = surfaceOf(sq); if (t && t.shape !== 'ASP') t.shape = name; break; }
      case 'K': { const t = surfaceOf(sq); if (t) { t.k = num(rest[0], 0); if (t.shape === 'SPH') t.shape = 'CON'; } break; }
      case 'A': case 'B': case 'C': case 'D': case 'E': case 'F': case 'G': case 'H': case 'J': {
        const t = surfaceOf(sq);
        if (t) { t.coef[name] = num(rest[0], 0); t.shape = 'ASP'; }
        break;
      }
      case 'SPS': { const t = surfaceOf(sq); if (t) t.sps = { type: (rest[0] || '').toUpperCase(), nr: num(rest[1], 0), C: {}, k: 0 }; break; }
      case 'SCO': {
        const t = surfaceOf(sq);
        if (!t || !t.sps) break;
        const nm = (rest[0] || '').toUpperCase(), v = num(rest[1], 0);
        let m;
        if (nm === 'K' || nm === 'C1') t.sps.k = v;
        else if (nm === 'NRADIUS') t.sps.nr = v;
        else if ((m = nm.match(/^C(\d+)$/))) t.sps.C[parseInt(m[1], 10) - 1] = v;
        else if ((m = nm.match(/^AR(\d+)$/))) t.sps.C[parseInt(m[1], 10)] = v;
        break;
      }
      case 'CIR': {
        const t = surfaceOf(sq);
        if (!t) break;
        const kind = rest.find(x => /^(EDG|OBS|HOL|CLR)$/i.test(x))?.toUpperCase() || 'CLR';
        const v = num(rest.filter(x => !/^[A-Z]/i.test(x)).at(-1));
        if (!Number.isFinite(v)) break;
        if (kind === 'CLR') t.cir = v; else if (kind === 'OBS') t.cirObs = v;
        else if (kind === 'HOL') t.apertureNotes.push('HOL');
        break;
      }
      case 'REX': case 'REY': case 'ELX': case 'ELY': case 'HEX': case 'POL_': {
        const t = surfaceOf(sq); if (t && !t.apertureNotes.includes('rect')) t.apertureNotes.push('rect'); break;
      }
      case 'ADX': case 'ADY': { const t = surfaceOf(sq); if (t) t[name.toLowerCase()] = num(rest[0], 0); break; }
      case 'XDE': case 'YDE': case 'ZDE': case 'ADE': case 'BDE': case 'CDE': {
        const t = surfaceOf(sq); if (t) { t.dec = t.dec || {}; t.dec[name] = num(rest[0], 0); } break;
      }
      case 'DAR': case 'BEN': case 'REV': { const t = surfaceOf(sq); if (t) t.decType = name; break; }
      case 'DIF': {
        const t = surfaceOf(sq);
        if (!t) break;
        if (/^DOE$/i.test(rest[0] || '')) t.doe = { hor: 1, hwl: null, hct: 'R', C: {} };
        else log.warn(`面的衍射类型 DIF ${rest[0]} 不支持（只支持 DOE），没有转换。`, `DIF ${rest[0]} not supported (only DOE).`);
        break;
      }
      case 'HOR': case 'HWL': case 'HCT': case 'HCO': {
        const t = surfaceOf(sq);
        if (!t || !t.doe) break;
        if (name === 'HOR') t.doe.hor = num(rest[0], 1);
        else if (name === 'HWL') t.doe.hwl = num(rest[0]);
        else if (name === 'HCT') t.doe.hct = (rest[0] || 'R').toUpperCase();
        else { const m = (rest[0] || '').match(/^C(\d+)$/i); if (m) t.doe.C[parseInt(m[1], 10)] = num(rest[1], 0); }
        break;
      }
      case 'RMD': { const t = surfaceOf(sq); if (t && rest.some(x => /^REFL$/i.test(x))) t.refl = true; break; }
      case 'THI': {
        const t = surfaceOf(sq);
        if (!t) break;
        const oal = rest.findIndex(x => /^OAL$/i.test(x));
        if (oal >= 0) {
          const m = (rest[oal + 1] || '').match(/^S(\d+|O)\.\.(\d+|I)$/i);
          if (m) t.oal = { from: m[1].toUpperCase() === 'O' ? 0 : +m[1], to: m[2], len: num(rest[oal + 2]) };
        } else if (Number.isFinite(num(rest[0]))) t.thi = num(rest[0]);
        break;
      }
      case 'RDY': case 'CUY': {
        const t = surfaceOf(sq);
        const v = num(rest[0]);
        if (t && Number.isFinite(v)) t.curv = name === 'CUY' ? v : (v ? 1 / v : 0);
        break;
      }
      case 'GLA': { const t = surfaceOf(sq); if (t && rest[0]) t.glass = rest[0]; break; }
      case 'PIK': L.pickups++; break;
      case 'ZOO': {
        if (rest.length === 1 && /^\d+$/.test(rest[0]) && !quals.length) { L.nz = parseInt(rest[0], 10); break; }
        if (!c.args.length) break;
        const item = c.args[0].toUpperCase();
        if (item === 'TIT') break;
        let j = 1;
        const q = [];
        while (j < c.args.length && QUAL.test(c.args[j])) q.push(c.args[j++].toUpperCase());
        L.zoom.set(`${item}|${q.join(' ')}`, c.args.slice(j));
        break;
      }
      case 'PRV': inPrv = true; prvWl = []; break;
      default:
        if (TOLERANCE.has(name)) L.tolerances++;
        else if (!IGNORED.has(name)) L.unknown.add(name);
    }
  }
  return L;
}

// ======================================================================
// Conversion
// ======================================================================

export function convertSeqBytes(bytes, opts = {}) {
  const { text, encoding } = decodeBytes(bytes);
  const res = convertSeq(text, opts);
  res.info.inputEncoding = encoding;
  return res;
}

/** The .zmx text as bytes: plain ASCII when possible, otherwise UTF-16LE with BOM
 *  (what OpticStudio itself writes, so Chinese titles survive). */
export function encodeZmx(text) {
  if (!/[^\x00-\x7f]/.test(text)) return new TextEncoder().encode(text);
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xFF; out[1] = 0xFE;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 + 2 * i] = c & 0xFF; out[3 + 2 * i] = c >> 8; }
  return out;
}

const zf = v => {                                       // .zmx number: shortest exact form
  if (v === 0 || Object.is(v, -0)) return '0';
  const a = Math.abs(v);
  return (a >= 1e-4 && a < 1e15) ? String(v) : v.toExponential();
};
const E = v => v.toExponential(12).replace(/e([+-])(\d)$/, 'e$10$2').toUpperCase();

/** Cauchy fit n = A + B/λ² + C/λ⁴ through a private glass table → nd, vd. */
function privateGlass(entry) {
  const wl = entry.wl || [], n = entry.args.map(x => num(x));
  if (!wl.length || n.length < wl.length || n.slice(0, wl.length).some(v => !Number.isFinite(v))) return null;
  const pts = wl.map((w, i) => [1 / ((w / 1000) ** 2), n[i]]);
  const m = Math.min(3, pts.length);
  // least squares in x = 1/λ² with m terms (1, x, x²)
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const [x, y] of pts) {
    const p = [1, x, x * x].slice(0, m);
    for (let r = 0; r < m; r++) { for (let s = 0; s < m; s++) A[r][s] += p[r] * p[s]; A[r][m] += p[r] * y; }
  }
  for (let i = 0; i < m; i++) {
    let piv = i;
    for (let r = i + 1; r < m; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < m; r++) {
      if (r === i || !A[i][i]) continue;
      const f = A[r][i] / A[i][i];
      for (let s = i; s <= m; s++) A[r][s] -= f * A[i][s];
    }
  }
  const co = A.map((row, i) => row[m] / row[i]);
  const at = um => co.reduce((s, c, i) => s + c * (1 / (um * um)) ** i, 0);
  const nd = at(0.5875618), nF = at(0.4861327), nC = at(0.6562725);
  return { nd, vd: nF - nC ? (nd - 1) / (nF - nC) : 0 };
}

export function convertSeq(text, options = {}) {
  const o = { glassTable: null, fileName: '', date: null, ...options };
  const log = new Log();
  const L = parseSeq(text, log);
  const S = L.surfaces;
  if (S.length < 2 || S[0].kind !== 'SO') {
    throw new ConversionError('没有读到镜头面数据（SO / S / SI），这不像是 CODE V 的镜头 .seq 文件（宏文件也不行）。',
      'No lens surfaces (SO / S / SI) found - this is not a CODE V lens sequence file.');
  }
  if (S[S.length - 1].kind !== 'SI') {
    log.warn('文件里没有 SI（像面），最后一个面当作像面。', 'No SI (image surface); the last surface is used as the image.');
  }
  const N = S.length - 1;
  const unit = { M: 'MM', C: 'CM', I: 'IN' }[L.dim] || 'MM';
  const mmPerUnit = MM_PER_UNIT[L.dim] || 1;

  // ---------------------------------------------------------------- zoom positions
  let nz = L.nz;
  for (const v of L.zoom.values()) nz = Math.max(nz, v.length);
  nz = Math.max(nz, L.titles.length, 1);
  const Z = Array.from({ length: nz }, (_, i) => i);
  const used = new Set();
  // values of item|quals in every zoom position: zoom row if present (padded with its last value), else base
  const zv = (key, base, parse = v => num(v)) => {
    const row = L.zoom.get(key);
    if (!row) return Z.map(() => base);
    used.add(key);
    return Z.map(i => {
      const raw = row[Math.min(i, row.length - 1)];
      const v = raw === undefined ? undefined : parse(raw);
      return v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? base : v;
    });
  };
  const differs = arr => arr.some(v => (typeof v === 'number' ? Math.abs(v - arr[0]) > 1e-12 * Math.max(1, Math.abs(v)) : v !== arr[0]));
  const sKey = i => (i === 0 ? 'SO' : `S${i}`);
  const sKeys = i => (i === N ? [`S${i}`, 'SI'] : (i === 0 ? ['S0', 'SO'] : [`S${i}`]));
  const zs = (item, i, base, parse) => {
    for (const q of sKeys(i)) if (L.zoom.has(`${item}|${q}`)) return zv(`${item}|${q}`, base, parse);
    return Z.map(() => base);
  };

  // ---------------------------------------------------------------- glasses
  const table = o.glassTable;
  if (!table) {
    log.warn('没有加载玻璃映射表 CV2ZMX_GLASS.DAT，目录玻璃只能按 CODE V 名字写出。', 'Glass map not loaded: catalog glasses keep their CODE V names.');
  }
  const gcat = [];
  const glassReport = [];
  const resolveGlass = (tok, i) => {
    if (!tok) return null;
    const raw = unquote(tok);
    const U = raw.toUpperCase();
    if (U === 'AIR') return null;
    const mg = decodeModelGlass(tok);
    let r;
    if (mg && !/^['"]/.test(tok)) {
      r = { kind: 'model', nd: mg.nd, vd: mg.vd };
    } else if (L.prv.has(U)) {
      const pg = privateGlass(L.prv.get(U));
      if (pg) {
        r = { kind: 'model', nd: pg.nd, vd: pg.vd };
        log.warn(`面 ${i} 的玻璃 ${raw} 是文件里自定义的私有玻璃，已按它的折射率表拟合成模型玻璃 nd=${pg.nd.toFixed(5)} vd=${pg.vd.toFixed(2)}。`,
          `S${i}: private glass ${raw} fitted to a model glass nd ${pg.nd.toFixed(5)} vd ${pg.vd.toFixed(2)}.`);
      } else {
        r = { kind: 'unknown', name: raw };
        log.warn(`面 ${i} 的私有玻璃 ${raw} 用的是公式定义，读不出折射率，按名字写出，请在 Zemax 里补上。`,
          `S${i}: private glass ${raw} is defined by a formula; written by name, fix it in Zemax.`);
      }
    } else if (table && table.byCv.has(U)) {
      const row = table.byCv.get(U);
      r = { kind: 'catalog', name: row.zname, cat: row.zcat, nd: row.nd, vd: row.vd };
    } else {
      const k = U.lastIndexOf('_');
      const rows = table && k < 0 ? table.byCvName.get(U) : null;
      if (rows && rows.length) {
        const row = rows.find(x => x.cvCat === 'SCHOTT') || rows[0];
        r = { kind: 'catalog', name: row.zname, cat: row.zcat, nd: row.nd, vd: row.vd };
        if (rows.length > 1) {
          log.info(`玻璃 ${raw} 没写厂家，几家目录都有，取了 ${row.cv}。`, `Glass ${raw} has no catalog suffix; used ${row.cv}.`);
        }
      } else {
        r = { kind: 'unknown', name: k > 0 ? raw.slice(0, k) : raw };
        log.warn(`玻璃 ${raw} 在映射表里找不到 Zemax 对应牌号，按名字 ${r.name} 写出，Zemax 打开会标成未知玻璃，请手工指定。`,
          `Glass ${raw} has no Zemax counterpart in the glass map; written as ${r.name}, Zemax will flag it.`);
      }
    }
    if (r.cat && !gcat.includes(r.cat)) gcat.push(r.cat);
    glassReport.push({ surface: i, codev: raw, zemax: r.kind === 'model' ? `模型 ${r.nd.toFixed(5)}/${r.vd.toFixed(2)}` : r.name, kind: r.kind });
    return r;
  };

  // ---------------------------------------------------------------- surfaces
  let prevMedium = null;
  const surf = S.map((s, i) => {
    const d = { s, i };
    d.medium = s.refl ? 'MIRROR' : resolveGlass(s.glass, i);
    if (!s.refl) {
      d.sameMedium = (d.medium === null && prevMedium === null)
        || (d.medium && prevMedium && d.medium.name === prevMedium.name && d.medium.nd === prevMedium.nd);
      prevMedium = d.medium;
    }
    d.thi = zs('THI', i, s.thi);
    d.thc = zs('THC', i, '100', x => String(x));
    d.curv = zs('CUY', i, s.curv);
    const rdy = zs('RDY', i, NaN);
    if (rdy.some(Number.isFinite)) d.curv = rdy.map((r, z) => (Number.isFinite(r) ? (r ? 1 / r : 0) : d.curv[z]));
    d.k = zs('K', i, s.sps ? s.sps.k : s.k);
    d.coef = Object.fromEntries(ASP.map(l => [l, zs(l, i, s.coef[l] || 0)]));
    d.cir = zs('CIR', i, s.cir);
    d.dec = Object.fromEntries(DEC.map(l => [l, zs(l, i, (s.dec && s.dec[l]) || 0)]));
    return d;
  });
  if (!S.some(s => s.stop)) {
    if (N > 1) S[1].stop = true;
    log.info('文件里没有 STO，按 CODE V 的默认把面 1 当光阑。', 'No STO in the file: surface 1 is the stop (CODE V default).');
  }

  // Zemax surface type
  for (const d of surf) {
    const { s, i } = d;
    const hasDec = DEC.some(l => d.dec[l].some(v => v));
    const hiZoom = d.coef.H.some(v => v) || d.coef.J.some(v => v);
    const anyCoef = ASP.some(l => d.coef[l].some(v => v));
    d.type = 'STANDARD';
    if (hasDec) {
      const dummy = d.curv.every(c => c === 0) && !anyCoef && !s.sps && !s.doe && d.cir.every(v => v === null)
        && !s.refl && d.sameMedium && s.decType === 'BAS' && d.dec.ZDE.every(v => !v) && i > 0 && i < N;
      if (dummy) d.type = 'COORDBRK';
      else {
        log.warn(`面 ${i} 有偏心/倾斜（${s.decType === 'BAS' ? '基本偏心' : s.decType}），不是单独的哑面，没有转换。`,
          `S${i}: decenter/tilt (${s.decType}) on a non-dummy surface not converted.`);
      }
    }
    if (d.type === 'COORDBRK') continue;
    if (s.sps) {
      if (s.sps.type === 'ODD') d.type = Object.keys(s.sps.C).some(p => p % 2 && s.sps.C[p]) ? 'XOSPHERE' : 'XASPHERE';
      else log.warn(`面 ${i} 是 SPS ${s.sps.type} 特殊面，不支持，只按基础曲率写出。`, `S${i}: SPS ${s.sps.type} not supported; base curvature only.`);
    } else if (s.doe) {
      d.type = 'BINARY_2';
      if (hiZoom) log.warn(`面 ${i} 是衍射面，Binary 2 的非球面只到 r^16，H/J 项丢了。`, `S${i}: DOE surface: aspheric H/J dropped (Binary 2 stops at r^16).`);
      if (s.doe.hct !== 'R') log.warn(`面 ${i} 的衍射相位类型 HCT ${s.doe.hct} 不支持（只支持旋转对称 R）。`, `S${i}: HCT ${s.doe.hct} not supported (R only).`);
    } else if (anyCoef || s.shape === 'ASP') {
      d.type = hiZoom ? 'XASPHERE' : 'EVENASPH';
    }
    if (s.cirObs !== null && d.type !== 'COORDBRK') { /* written below */ }
    if (s.apertureNotes.includes('rect')) log.warn(`面 ${i} 有矩形/椭圆口径，没有转换。`, `S${i}: rectangular/elliptical aperture not converted.`);
    if (s.apertureNotes.includes('HOL')) log.warn(`面 ${i} 有 CIR HOL（中心孔），没有转换。`, `S${i}: CIR HOL (hole) not converted.`);
  }

  // ---------------------------------------------------------------- fields & wavelengths
  const ftype = L.ftype || 'AN';
  const fx = L.fld.X, fy = L.fld.Y;
  const nf = Math.max(fx.length, fy.length, 1);
  const F = Array.from({ length: nf }, (_, f) => {
    const q = `F${f + 1}`;
    const g = (item, base) => zv(`${item}|${q}`, base);
    const r = {
      x: g('X' + ftype, fx[f] || 0), y: g('Y' + ftype, fy[f] || 0), w: g('WTF', L.fld.WTF[f] ?? 1),
      vux: g('VUX', L.fld.VUX[f] || 0), vlx: g('VLX', L.fld.VLX[f] || 0),
      vuy: g('VUY', L.fld.VUY[f] || 0), vly: g('VLY', L.fld.VLY[f] || 0),
    };
    // the macro's formulas: VCY = (VUY+VLY)/2, VDY = (VLY−VUY)/2
    const c15 = v => +v.toPrecision(15);                 // (0.02 − 0.05)/2 → −0.015, not −0.015000000000000001
    r.vcy = Z.map(z => c15((r.vuy[z] + r.vly[z]) / 2));
    r.vdy = Z.map(z => c15((r.vly[z] - r.vuy[z]) / 2));
    r.vcx = Z.map(z => c15((r.vux[z] + r.vlx[z]) / 2));
    r.vdx = Z.map(z => c15((r.vlx[z] - r.vux[z]) / 2));
    return r;
  });
  let wl = (L.wl && L.wl.length) ? L.wl : null;
  if (!wl) {
    wl = [587.5618];
    log.warn('文件里没有波长（WL），按 587.56 nm 单波长写出。', 'No WL in the file; wrote 587.56 nm.');
  }
  if (wl.length > 24) throw new ConversionError('Zemax 最多 24 个波长。', 'Zemax holds at most 24 wavelengths.');
  const W = wl.map((w, j) => ({ nm: zv(`WL|W${j + 1}`, w), wt: zv(`WTW|W${j + 1}`, (L.wtw && L.wtw[j]) ?? 1) }));
  let ref = L.ref;
  if (!ref || ref < 1 || ref > wl.length) {
    ref = 1;
    if (wl.length > 1) log.info(`文件里没有 REF，按第 1 个波长 ${wl[0]} nm 当主波长。`, `No REF: wavelength 1 (${wl[0]} nm) is the primary wavelength.`);
  }
  const refZ = zv('REF|', ref, v => parseInt(v, 10));

  // ---------------------------------------------------------------- aperture
  if (!L.aperture || !Number.isFinite(L.aperture.value)) {
    log.warn('文件里没有孔径（EPD/FNO/NAO），按 EPD 10 写出。', 'No aperture in the file; wrote EPD 10.');
    L.aperture = { type: 'EPD', value: 10 };
  }
  const apType = L.aperture.type;
  let apVals = zv(`${apType}|`, L.aperture.value);
  for (const t of ['EPD', 'FNO', 'NAO', 'NA']) {
    if (t !== apType && L.zoom.has(`${t}|`)) log.warn(`多重结构里的 ZOO ${t} 和头部孔径类型 ${apType} 不同，没有转换。`, `ZOO ${t} differs from the aperture type ${apType}; not converted.`);
  }
  if (apType === 'NA') {
    apVals = apVals.map(v => 1 / (2 * v));
    log.info('孔径是像方 NA，已换算成工作 F/# = 1/(2NA)。', 'Image space NA converted to working F/# = 1/(2 NA).');
  }
  const zKey = { EPD: 'ENPD', FNO: 'FNUM', NA: 'FNUM', NAO: 'OBNA' }[apType];

  // ---------------------------------------------------------------- writer (run twice for the F/# correction)
  const date = o.date ? new Date(o.date) : new Date();
  const stamp = `${date.getDate()}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
  const title = (L.title || (o.fileName || '').replace(/\.[^.]*$/, '') || 'SEQ2ZMX').replace(/\s+/g, ' ').trim();

  const write = (aper, notes) => {
    const T = [];
    const a = s => T.push(s);
    a('VERS 240529 1 1 L000001');
    a('MODE SEQ');
    a(`NAME ${title}`);
    a(`NOTE 0 Converted from CODE V sequence file ${o.fileName || ''} by seq2zmx ${VERSION} (github.com/anvcor/cv2zmx) on ${stamp}`.replace(/\s+/g, ' ').trim());
    for (const n of notes) a(`NOTE 0 ${n}`.slice(0, 132));
    a('NOTE 1 ""');
    a('PFIL 0 0 0');
    a('LANG 0');
    a(`UNIT ${unit} X W X CM MR CPMM`);
    if (zKey === 'ENPD') a(`ENPD ${zf(aper[0])}`);
    else if (zKey === 'OBNA') a(`OBNA ${zf(aper[0])} 0`);
    else a(`FNUM ${zf(aper[0])} 1`);
    a(`ENVD ${zf(L.tem ?? 22)} ${zf((L.pre ?? 760) / 760)} 0`);
    a('GFAC 0 0');
    a(`GCAT ${gcat.length ? gcat.join(' ') : 'SCHOTT'}`);
    a('RAIM 0 2 1 1 0 0 0 0 0 1');
    a('PUSH 0 0 0 0 0 0');
    a('SDMA 0 1 0');
    a('OMMA 1 1');
    a(`FTYP ${FIELD_TYPES[ftype]} 0 ${nf} ${wl.length} 0 0 0 ${nf}`);
    a('ROPD 2');
    a('PICB 1');
    const pad = vals => { const v = [...vals]; while (v.length < 12) v.push(0); return v.map(zf).join(' '); };
    a(`XFLN ${pad(F.map(f => f.x[0]))}`);
    a(`YFLN ${pad(F.map(f => f.y[0]))}`);
    a(`FWGN ${pad(F.map(f => f.w[0]))}`);
    a(`VDXN ${pad(F.map(f => f.vdx[0]))}`);
    a(`VDYN ${pad(F.map(f => f.vdy[0]))}`);
    a(`VCXN ${pad(F.map(f => f.vcx[0]))}`);
    a(`VCYN ${pad(F.map(f => f.vcy[0]))}`);
    a(`VANN ${pad([])}`);
    for (let j = 1; j <= 24; j++) {
      const w = W[j - 1];
      a(w ? `WAVM ${j} ${zf(Math.round(w.nm[0] * 1e6) / 1e9)} ${zf(w.wt[0])}` : `WAVM ${j} 0.55 0`);
    }
    a(`PWAV ${refZ[0]}`);
    a('POLS 1 0 1 0 0 1 0');
    a('GLRS 1 0');
    a('GSTD 0 100.000 100.000 100.000 100.000 100.000 100.000 0 1 1 0 0 1 1 1 1 1 1');
    a('NSCD 100 500 0 0.001 10 9.9999999999999995e-07 0 0 0 0 0 0 1000000 0 2');
    a('COFN QF "COATING.DAT" "SCATTER_PROFILE.DAT" "ABG_DATA.DAT" "PROFILE.GRD"');
    a('COFN COATING.DAT SCATTER_PROFILE.DAT ABG_DATA.DAT PROFILE.GRD');

    const xd = (n, v, scale = 1) => a(`  XDAT ${n} ${zf(v)} 0 0 ${E(scale)} ${E(0)} 0 ""`);
    for (const d of surf) {
      const { s, i } = d;
      a(`SURF ${i}`);
      if (s.stop && i > 0 && i < N) a('  STOP');
      if (s.label) a(`  COMM ${s.label}`);
      a(`  TYPE ${d.type}`);
      a(`  CURV ${zf(d.type === 'COORDBRK' ? 0 : d.curv[0])} 0 0 0 0 ""`);
      a('  HIDE 0 0 0 0 0 0 0 0 0 0 0 0');
      a('  MIRR 2 0');
      a(`  SLAB ${i + 1}`);
      const c = l => d.coef[l][0];
      if (d.type === 'EVENASPH') {
        a('  PARM 1 0');
        for (let p = 2; p <= 8; p++) a(`  PARM ${p} ${zf(c(ASP[p - 2]))}`);
      } else if (d.type === 'XASPHERE' && !s.sps) {
        xd(1, 10); xd(2, 1); xd(3, 0);
        ASP.forEach((l, j) => xd(j + 4, c(l)));
      } else if (s.sps && (d.type === 'XASPHERE' || d.type === 'XOSPHERE')) {
        const C = s.sps.C, nr = s.sps.nr || 1;
        const pmax = Math.max(2, ...Object.keys(C).filter(p => C[p]).map(Number));
        if (d.type === 'XASPHERE') {
          const n = Math.ceil(pmax / 2);
          xd(1, n); xd(2, nr);
          for (let j = 1; j <= n; j++) xd(j + 2, C[2 * j] || 0);
        } else {
          xd(1, pmax); xd(2, nr);
          for (let p = 1; p <= pmax; p++) xd(p + 2, C[p] || 0);
        }
      } else if (d.type === 'BINARY_2') {
        a(`  PARM 0 ${zf(s.doe.hor)}`);
        a('  PARM 1 0');
        for (let p = 2; p <= 8; p++) a(`  PARM ${p} ${zf(c(ASP[p - 2]))}`);
        const Cs = s.doe.C, nmax = Math.max(0, ...Object.keys(Cs).map(Number));
        const lam = ((s.doe.hwl || W[refZ[0] - 1].nm[0]) * 1e-6) / mmPerUnit;   // HWL in lens units
        xd(1, nmax, 0); xd(2, 1, 0);
        for (let j = 1; j <= nmax; j++) xd(j + 2, (2 * Math.PI / lam) * (Cs[j] || 0), 0);
      } else if (d.type === 'COORDBRK') {
        const v = l => d.dec[l][0];
        a(`  PARM 1 ${zf(v('XDE'))}`); a(`  PARM 2 ${zf(v('YDE'))}`);
        a(`  PARM 3 ${zf(v('ADE'))}`); a(`  PARM 4 ${zf(v('BDE'))}`); a(`  PARM 5 ${zf(v('CDE'))}`);
        a('  PARM 6 0');
      }
      a(Math.abs(d.thi[0]) >= INF_THI ? '  DISZ INFINITY' : `  DISZ ${zf(d.thi[0])}`);
      if (s.oal) {
        const to = s.oal.to.toUpperCase() === 'I' ? N : +s.oal.to;
        if (to === i + 1 && s.oal.from <= i && Number.isFinite(s.oal.len)) a(`  TOLE ${s.oal.from} ${zf(s.oal.len)}`);
        else if (!notes.done) log.warn(`面 ${i} 的 OAL 求解范围（S${s.oal.from}..${s.oal.to}）和 Zemax 的位置求解对不上，按当前厚度写出。`, `S${i}: OAL solve range S${s.oal.from}..${s.oal.to} has no Zemax position-solve equivalent; current thickness written.`);
      }
      if (d.type !== 'COORDBRK' && i < N) {
        const m = d.medium;
        if (m === 'MIRROR') a('  GLAS MIRROR 0 0 1.5 40 0 0 0 0 0 0');
        else if (m && m.kind === 'model') a(`  GLAS ___BLANK 1 0 ${zf(m.nd)} ${zf(m.vd)} 0 0 0 0 0 0`);
        else if (m) a(`  GLAS ${m.name} 0 0 ${zf(m.nd || 1.5)} ${zf(m.vd || 40)} 0 0 0 0 0 0`);
      }
      if (d.type !== 'STANDARD' && d.type !== 'COORDBRK' || d.k[0] || d.k.some(v => v)) {
        if (d.type !== 'COORDBRK') a(`  CONI ${zf(d.k[0])}`);
      }
      const cir = d.cir.filter(v => v !== null);
      if (cir.length && i > 0 && i < N) {
        const v = d.cir[0] ?? Math.max(...cir);
        a(`  DIAM ${zf(v)} 1 0 0 1 ""`);
        a(`  MEMA ${zf(v)} 0 0 0 1 ""`);
      } else {
        a('  DIAM 0 0 0 0 1 ""');
        a('  MEMA 0 0 0 0 1 ""');
      }
      a('  POPS 0 0 0 0 0 0 0 0 1 1 1 1 0 0 0 0');
      if (cir.length && i > 0 && i < N) a(`  CLAP 0 ${zf(Math.max(...cir))} 0`);
      if (s.cirObs !== null) a(`  OBSC 0 ${zf(s.cirObs)} 0`);
      if ((s.adx || s.ady) && cir.length) a(`  OBDC ${zf(s.adx)} ${zf(s.ady)}`);
    }

    // ---------------------------------------------------------------- multi-configuration
    a('TOL TOFF   0   0 0.0000000000000000E+00 0.0000000000000000E+00   0 0 0 0 0');
    a(`MNUM ${nz} 1`);
    if (nz > 1) {
      const row = (op, i1, vals, status = () => 0, i2 = 0) => {
        Z.forEach(z => a(`${op.padEnd(4)} ${String(i1).padStart(3)} ${String(z + 1).padStart(3)} ${zf(vals[z])} ${status(z)} ${i2} 0 1 1 1.000000000000E+00 0.000000000000E+00 0 "" 0`));
      };
      if (L.titles.some(Boolean)) {
        Z.forEach(z => a(`LTTL   0 ${String(z + 1).padStart(3)} "${(L.titles[z] || `Z${z + 1}`).replace(/"/g, "'")}" 0 0 0 1 1 0 0.0 "" 0`));
      }
      if (differs(aper)) row('APER', 0, aper);
      for (const d of surf) {
        const { s, i } = d;
        if (differs(d.thi)) {
          if (s.oal) log.info(`面 ${i} 有 OAL 求解，多重结构厚度交给 Zemax 的位置求解，没有写 THIC。`, `S${i}: thickness solved by the position solve; no THIC rows.`);
          else row('THIC', i, d.thi.map(v => (Math.abs(v) >= INF_THI ? 1e10 : v)), z => (d.thc[z] === '0' ? 1 : 0));
        }
      }
      for (const d of surf) if (d.type !== 'COORDBRK' && differs(d.curv)) row('CRVT', d.i, d.curv);
      for (const d of surf) if (differs(d.k)) row('CONN', d.i, d.k);
      for (const d of surf) {
        ASP.forEach((l, j) => {
          if (!differs(d.coef[l])) return;
          if (d.type === 'EVENASPH' || d.type === 'BINARY_2') {
            if (j < 7) row('PRAM', d.i, d.coef[l], () => 0, j + 2);
          } else if (d.type === 'XASPHERE' && !d.s.sps) row('EDVA', d.i, d.coef[l], () => 0, j + 4);
          else log.warn(`面 ${d.i} 的非球面系数 ${l} 随结构变化，这种面型没有对应的多重结构写法，没有转换。`, `S${d.i}: zoomed coefficient ${l} not converted for this surface type.`);
        });
      }
      for (const d of surf) {
        if (d.type === 'COORDBRK') {
          [['XDE', 1], ['YDE', 2], ['ADE', 3], ['BDE', 4], ['CDE', 5]].forEach(([l, p]) => { if (differs(d.dec[l])) row('PRAM', d.i, d.dec[l], () => 0, p); });
        }
      }
      for (const d of surf) {
        if (d.cir.some(v => v !== null) && differs(d.cir.map(v => v ?? 0))) {
          row('SDIA', d.i, d.cir.map(v => v ?? 0));
          log.info(`面 ${d.i} 的 CIR 随结构变化：写成多重结构 SDIA，挡光口径 CLAP 取各结构最大值。`, `S${d.i}: zoomed CIR written as SDIA rows; CLAP uses the largest value.`);
        }
      }
      W.forEach((w, j) => { if (differs(w.nm)) row('WAVE', j + 1, w.nm.map(v => v / 1000)); });
      W.forEach((w, j) => { if (differs(w.wt)) row('WLWT', j + 1, w.wt); });
      if (differs(refZ)) row('PWAV', 0, refZ);
      F.forEach((f, k) => {
        const n = k + 1;
        if (differs(f.y)) row('YFIE', n, f.y);
        if (differs(f.x)) row('XFIE', n, f.x);
        if (differs(f.w)) row('FLWT', n, f.w);
        if (differs(f.vdy)) row('FVDY', n, f.vdy);
        if (differs(f.vcy)) row('FVCY', n, f.vcy);
        if (differs(f.vdx)) row('FVDX', n, f.vdx);
        if (differs(f.vcx)) row('FVCX', n, f.vcx);
      });
      const tem = zv('TEM|', L.tem ?? 22), pre = zv('PRE|', L.pre ?? 760);
      if (differs(tem)) row('TEMP', 0, tem);
      if (differs(pre)) row('PRES', 0, pre.map(v => v / 760));
    }
    notes.done = true;
    return T.join('\r\n') + '\r\n';
  };

  // ---------------------------------------------------------------- warnings collected while reading
  if (L.pickups) log.warn(`文件里有 ${L.pickups} 条拾取（PIK），按当前值写出，Zemax 里不会联动。`, `${L.pickups} pickup(s) (PIK) written as current values.`);
  if (L.tolerances) log.info('公差和补偿器数据没有转换。', 'Tolerance / compensator data not converted.');
  if (L.unknown.size) log.info(`这些 CODE V 命令没有用到：${[...L.unknown].join(' ')}`, `Commands not used: ${[...L.unknown].join(' ')}`);
  for (const key of L.zoom.keys()) {
    const item = key.split('|')[0];
    if (!['THI', 'THC', 'CUY', 'RDY', 'K', 'CIR', 'EPD', 'FNO', 'NAO', 'NA', 'WL', 'WTW', 'REF', 'WTF', 'VUX', 'VLX', 'VUY', 'VLY',
      'TEM', 'PRE', ...ASP, ...DEC, 'X' + ftype, 'Y' + ftype].includes(item)) {
      log.warn(`多重结构 ZOO ${item} 没有对应的 Zemax 写法，没有转换。`, `ZOO ${item} not converted.`);
    }
  }
  if (S.some(s => s.refl)) log.info('有反射面：Zemax 和 CODE V 都用镜后厚度取负的约定，原样搬运，请在 Zemax 里看一眼布局。', 'Mirrors present: thickness signs copied as they are - check the layout in Zemax.');

  // ---------------------------------------------------------------- first pass, paraxial data, F/# correction
  const draft = write(apVals, []);
  let check;
  try {
    check = convertZmx(draft, { glassTable: table, comments: false, fieldOrder: 'keep', waveOrder: 'keep' });
  } catch (e) {
    throw new ConversionError(`内部自检失败：${e.zh || e.message}`, `Internal check failed: ${e.en || e.message}`);
  }
  let aper = apVals;
  const px = check.info.paraxial;
  if (zKey === 'FNUM' && px.some(p => p.finite)) {
    aper = apVals.map((v, z) => (px[z] && px[z].finite ? Math.sqrt(Math.max(v * v - (px[z].beta / 2) ** 2, 1e-12)) : v));
    log.info('有限共轭结构的 F 数已按 PWFN = √(FNO² − (β/2)²) 换算成 Zemax 的近轴工作 F/#（两边入瞳相同）。',
      'Finite-conjugate F/# converted with PWFN = sqrt(FNO^2 - (beta/2)^2) so the entrance pupil matches.');
  }
  // self check: the .zmx must give back the prescription that was read
  check.info.surfaceTable.forEach((row, i) => {
    const d = surf[i];
    if (!d) return;
    const t = d.thi[0], t2 = row.thickness;
    const thiOk = (Math.abs(t) >= INF_THI && Math.abs(t2) >= INF_THI) || Math.abs(t - t2) <= 1e-9 * Math.max(1, Math.abs(t));
    if (!thiOk) log.warn(`自检：面 ${i} 的厚度转换后不一致（${t} → ${t2}），请反馈。`, `Self-check: S${i} thickness ${t} became ${t2}.`);
  });
  const notes = log.items.filter(w => w.level === 'warn').map(w => w.en);
  notes.push(`Paraxial EFL (indices from nd/vd): ${px.map(p => `Z${p.cfg} ${Number.isFinite(p.efl) ? p.efl.toFixed(5) : 'inf'}`).join(', ')}`);
  const zmx = write(aper, notes);

  return {
    zmx,
    warnings: log.items,
    info: {
      title, unit, surfaces: N - 1, fields: nf, wavelengths: wl.length, configurations: nz,
      aperture: { key: zKey, values: aper }, glasses: glassReport, paraxial: px, gcat,
    },
  };
}
