// UI for zmx2seq.js. Everything runs locally; files never leave the browser.
import { convertBytes, parseGlassTable, encodeText, ConversionError, VERSION } from './zmx2seq.js';

const $ = sel => document.querySelector(sel);
const results = $('#results');
const form = $('#opts');
const state = { table: null, files: [] };          // files: { name, bytes, example }
const OPTS_KEY = 'cv2zmx-options-v1';

$('#ver').textContent = VERSION;

// ------------------------------------------------------------------ small DOM helper
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

const num = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : (Number.isNaN(v) ? '—' : '∞'));

// ------------------------------------------------------------------ options
function readOpts() {
  return {
    sd: form.sd.value,
    offsetGlass: form.offsetGlass.value,
    unknownGlass: form.unknownGlass.value,
    encoding: form.encoding.value,
    oal: form.oal.checked,
    zoomVars: form.zoomVars.checked,
    waveOrder: form.waveOrder.checked ? 'descending' : 'keep',
    fieldOrder: form.fieldOrder.checked ? 'ascending' : 'keep',
    comments: form.comments.checked,
  };
}
function restoreOpts() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPTS_KEY) || 'null'); } catch { saved = null; }
  if (!saved) return;
  for (const k of ['sd', 'offsetGlass', 'unknownGlass', 'encoding']) if (saved[k]) form[k].value = saved[k];
  for (const k of ['oal', 'zoomVars', 'comments']) if (typeof saved[k] === 'boolean') form[k].checked = saved[k];
  if (saved.waveOrder) form.waveOrder.checked = saved.waveOrder === 'descending';
  if (saved.fieldOrder) form.fieldOrder.checked = saved.fieldOrder === 'ascending';
}
form.addEventListener('change', () => {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(readOpts())); } catch { /* storage unavailable */ }
  renderAll();
});

// ------------------------------------------------------------------ loading files
async function fetchFirst(paths, kind = 'text') {
  for (const p of paths) {
    try {
      const r = await fetch(p);
      if (r.ok) return kind === 'text' ? await r.text() : new Uint8Array(await r.arrayBuffer());
    } catch { /* try the next path */ }
  }
  throw new Error('not found: ' + paths.join(', '));
}

function setGlassStatus(ok, text) {
  $('#gm-dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('#gm-text').textContent = text;
}

async function loadGlassTable() {
  try {
    const text = await fetchFirst(['CV2ZMX_GLASS.DAT', '../CV2ZMX_GLASS.DAT']);
    state.table = parseGlassTable(text);
    setGlassStatus(true, `玻璃映射表 CV2ZMX_GLASS.DAT · ${state.table.size} 条`);
  } catch {
    state.table = null;
    setGlassStatus(false, '没找到 CV2ZMX_GLASS.DAT，目录玻璃会写成模型玻璃。可以手动选一个映射表。');
  }
}

$('#gm-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const t = parseGlassTable(new TextDecoder('latin1').decode(await f.arrayBuffer()));
  if (!t.size) { toast(`${f.name} 里没有读到映射记录（每行应为：CODEV名_厂家 Zemax名 Zemax目录 nd vd）`); return; }
  state.table = t;
  setGlassStatus(true, `玻璃映射表 ${f.name} · ${t.size} 条`);
  renderAll();
});

async function addFiles(fileList) {
  const list = [...fileList].filter(f => /\.zmx$/i.test(f.name));
  if (!list.length) { toast('请选择 .zmx 文件'); return; }
  const loaded = await Promise.all(list.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), example: false })));
  state.files = [...state.files.filter(f => !f.example), ...loaded];
  renderAll();
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadExample(name) {
  try {
    const bytes = await fetchFirst([`examples/${name}`, `../test/fixtures/${name}`], 'bytes');
    state.files = [{ name, bytes, example: true }, ...state.files.filter(f => !f.example)];
    renderAll();
  } catch {
    toast(`示例 ${name} 加载失败`);
  }
}

$('#file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
document.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => loadExample(b.dataset.example)));

// ------------------------------------------------------------------ saving
// Inside a claude.ai artifact the page cannot start downloads itself; the viewer offers a
// `downloads` capability that only accepts a fixed list of extensions (.txt, not .seq).
let viewerDownloads = null;
if (typeof window.claude?.use === 'function') {
  window.claude.use('downloads').then(ns => { viewerDownloads = ns; renderAll(); }).catch(() => {});
}
const seqName = name => name.replace(/\.zmx$/i, '') + '.seq';

async function saveSeq(name, bytes) {
  if (viewerDownloads) {
    try {
      await viewerDownloads.save({ filename: name + '.txt', data: bytes.slice() });
      toast(`已保存 ${name}.txt，把扩展名改成 .seq 即可`);
    } catch (e) {
      if (e?.code !== 'declined') toast('这里不能保存文件，请用“复制”');
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copySeq(text, pre) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制 .seq 内容');
  } catch {
    const r = document.createRange();
    r.selectNodeContents(pre);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    toast('已选中全文，按 Ctrl+C 复制');
  }
}

// ------------------------------------------------------------------ rendering
function renderAll() {
  results.replaceChildren();
  if (!state.files.length) {
    results.append(h('div', { class: 'card empty' }, '把 .zmx 文件拖到左边，或点一个示例。'));
    return;
  }
  const opts = readOpts();
  for (const f of state.files) results.append(renderFile(f, opts));
}

function renderFile(file, opts) {
  let res;
  try {
    res = convertBytes(file.bytes, { ...opts, glassTable: state.table, fileName: file.name });
  } catch (e) {
    const msg = e instanceof ConversionError ? e.zh : `转换出错：${e.message}`;
    return h('article', { class: 'card err-card' },
      h('header', { class: 'card-h' }, h('div', {}, h('h2', {}, file.name))),
      h('div', { class: 'card-b' }, msg));
  }
  const I = res.info;
  const outName = seqName(file.name);
  const bytes = encodeText(res.seq, opts.encoding);
  const seqLines = res.seq.split('\r\n').length - 1;
  const pre = h('pre', { class: 'seq' });
  pre.append(highlight(res.seq));

  const warns = res.warnings.filter(w => w.level === 'warn').length;
  const label = viewerDownloads ? '保存 .seq.txt' : '下载 .seq';

  return h('article', { class: 'card' },
    h('header', { class: 'card-h' },
      h('div', {},
        h('h2', {}, file.name, file.example ? h('span', { class: 'tag' }, '示例') : null),
        h('p', { class: 'meta' }, [I.title, I.inputEncoding, I.zemaxVersion ? 'VERS ' + I.zemaxVersion.split(/\s+/)[0] : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => saveSeq(outName, bytes) }, label),
        h('button', { class: 'btn', type: 'button', onclick: () => copySeq(res.seq, pre) }, '复制'))),
    h('div', { class: 'card-b' },
      facts(I),
      notes(res.warnings),
      h('div', { class: 'split' }, layoutFigure(I), paraxTable(I)),
      h('details', { open: true },
        h('summary', {}, '面数据', h('span', { class: 'count' }, `结构 1 · ${I.surfaces} 个面`)),
        surfaceTable(I)),
      h('details', {},
        h('summary', {}, '玻璃对照', h('span', { class: 'count' }, `${I.glasses.length} 处`)),
        glassTable(I)),
      h('details', { open: true },
        h('summary', {}, outName, h('span', { class: 'count' }, `${seqLines} 行 · ${bytes.length} 字节${warns ? ` · ${warns} 条警告写在文件头` : ''}`)),
        pre)));
}

function facts(I) {
  const ap = I.aperture;
  const apv = ap.values.length > 1 && ap.values.some(v => Math.abs(v - ap.values[0]) > 1e-9)
    ? `${num(ap.values[0], 3)}…${num(ap.values.at(-1), 3)}` : num(ap.values[0], 3);
  const item = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, v));
  return h('dl', { class: 'facts' },
    item('面', I.surfaces), item('视场', `${I.fields} · ${I.fieldType}`), item('波长', I.wavelengths),
    item('结构', I.configurations), item('孔径', `${ap.key} ${apv}`), item('单位', I.unit));
}

function notes(list) {
  if (!list.length) return h('p', { class: 'clean' }, '全部内容都已转换，没有需要注意的地方。');
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...list].sort((a, b) => order[a.level] - order[b.level]);
  return h('ul', { class: 'notes' }, sorted.map(w =>
    h('li', { class: w.level }, h('span', { class: 'lvl' }, w.level === 'warn' ? '注意' : (w.level === 'error' ? '错误' : '说明')), w.zh)));
}

function paraxTable(I) {
  const rows = I.paraxial.map(p => h('tr', {},
    h('td', {}, h('span', { class: 'mono' }, `Z${p.cfg}`), p.title ? ' ' + p.title : ''),
    h('td', { class: 'num' }, num(p.efl)), h('td', { class: 'num' }, num(p.bfl)),
    h('td', { class: 'num' }, num(p.defocus)),
    h('td', { class: 'num', title: p.finite ? '' : '物在无限远' }, p.finite ? num(p.beta, 4) : '—'),
    h('td', { class: 'num' }, `${p.apertureKey} ${num(p.aperture, 4)}`)));
  return h('div', { class: 'tbl-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, ['结构', 'EFL', '近轴后焦', '像面离焦', '倍率', '孔径'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows)),
    h('p', { class: 'clean' }, '近轴核对：折射率按 nd/vd 估算到主波长，和 CODE V 里的 EFL 应在小数点后三四位一致。像面离焦 = 最后一段厚度 − 近轴后焦。'));
}

const KIND = {
  catalog: ['目录', ''], model: ['模型玻璃', ''], 'offset-base': ['Offset→基准', 'warn'],
  'offset-model': ['Offset→模型', 'warn'], unknown: ['未匹配→模型', 'warn'], guess: ['按名字猜', 'warn'],
};
function glassTable(I) {
  if (!I.glasses.length) return h('p', { class: 'clean' }, '没有玻璃（全是空气或反射面）。');
  return h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['面', 'Zemax', 'CODE V', '方式', 'nd', 'vd'].map(t => h('th', {}, t)))),
    h('tbody', {}, I.glasses.map(g => {
      const [txt, cls] = KIND[g.kind] || [g.kind, ''];
      return h('tr', {},
        h('td', { class: 'mono' }, `S${g.surface}${g.where !== 'LDE' ? ' ' + g.where : ''}`),
        h('td', { class: 'mono' }, g.zemax), h('td', { class: 'mono' }, g.codev),
        h('td', {}, h('span', { class: 'kind ' + cls }, txt)),
        h('td', { class: 'num' }, Number.isFinite(g.nd) ? g.nd.toFixed(5) : '—'),
        h('td', { class: 'num' }, Number.isFinite(g.vd) ? g.vd.toFixed(2) : '—'));
    }))));
}

function surfaceTable(I) {
  return h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['面', '标签', 'Zemax 面型', '写成', '半径', '厚度', 'CODE V 玻璃', '半口径'].map(t => h('th', {}, t)))),
    h('tbody', {}, I.surfaceTable.map(s => h('tr', { class: s.stop ? 'stop' : '' },
      h('td', { class: 'mono' }, s.i === 0 ? 'SO' : (s.i === I.surfaceTable.length - 1 ? 'SI' : `S${s.i}`)),
      h('td', {}, s.label || ''),
      h('td', { class: 'mono' }, s.type),
      h('td', { class: 'mono' }, s.shape === 'SPH' ? '' : s.shape),
      h('td', { class: 'num' }, s.radius === '0.0' ? '∞' : s.radius),
      h('td', { class: 'num' }, Math.abs(s.thickness) >= 1e10 ? '∞' : String(+s.thickness.toPrecision(10))),
      h('td', { class: 'mono' }, s.codevGlass),
      h('td', { class: 'num' }, s.sd ? (s.cir ? 'CIR ' : '') + num(s.sd, 3) : ''))))));
}

// cross-section of the first configuration, drawn to scale
function sag(c, k, poly, r) {
  const q = 1 - (1 + k) * c * c * r * r;
  let z = q > 0 ? (c * r * r) / (1 + Math.sqrt(q)) : (c ? 1 / c : 0);
  for (const [p, a] of poly) z += a * Math.pow(Math.abs(r), p);     // rotationally symmetric: |r|^p
  return z;
}
function layoutFigure(I) {
  const L = I.layout;
  const fig = h('figure', { class: 'figure' });
  if (!L || L.length < 2) {
    fig.append(h('figcaption', {}, '含反射面、坐标断点或无限远间隔的系统不画剖面图。'));
    return fig;
  }
  // semi-diameters: fall back to the neighbours for surfaces without one
  const sds = L.map(s => s.sd);
  const maxSd = Math.max(...sds.filter(v => v > 0), 1);
  const sdOf = i => {
    if (sds[i] > 0) return sds[i];
    for (let d = 1; d < L.length; d++) {
      if (sds[i - d] > 0) return sds[i - d];
      if (sds[i + d] > 0) return sds[i + d];
    }
    return maxSd;
  };
  const prof = L.map((s, i) => {
    let r = sdOf(i);
    const lim = (1 + s.k) * s.c * s.c;
    if (lim > 0) r = Math.min(r, 0.999 / Math.sqrt(lim));
    const pts = [];
    for (let j = 0; j <= 40; j++) {
      const y = -r + (2 * r * j) / 40;
      pts.push([s.z + sag(s.c, s.k, s.poly, y), y]);
    }
    return pts;
  });
  const xs = prof.flat().map(p => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ymax = Math.max(...L.map((_, i) => sdOf(i)));
  const pad = 0.06 * Math.max(x1 - x0, 2 * ymax);
  const vb = [x0 - pad, -ymax - pad, x1 - x0 + 2 * pad, 2 * ymax + 2 * pad];
  const svg = svgEl('svg', { viewBox: vb.join(' '), role: 'img', 'aria-label': '镜头剖面（结构 1）' });
  const g = svgEl('g', { transform: 'scale(1,-1)' });
  svg.append(g);
  const path = pts => pts.map((p, j) => `${j ? 'L' : 'M'}${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('');
  g.append(svgEl('line', { x1: vb[0], x2: vb[0] + vb[2], y1: 0, y2: 0, class: 'axis' }));
  L.forEach((s, i) => {
    if (s.glass && i + 1 < L.length) {
      const d = path(prof[i]) + path([...prof[i + 1]].reverse()).replace(/^M/, 'L') + 'Z';
      g.append(svgEl('path', { d, class: 'lens-fill' }));
    } else if (!s.image && !(i > 0 && L[i - 1].glass) && (s.c || s.poly.length)) {
      g.append(svgEl('path', { d: path(prof[i]), class: 'surf-line' }));    // a curved surface in air
    }
    if (s.stop) {
      const r = sdOf(i), e = 0.18 * ymax;
      g.append(svgEl('path', { d: `M${s.z},${r}L${s.z},${r + e}M${s.z},${-r}L${s.z},${-r - e}`, class: 'stop-mark' }));
    }
    if (s.image) g.append(svgEl('line', { x1: s.z, x2: s.z, y1: -ymax, y2: ymax, class: 'img-plane' }));
  });
  fig.append(svg, h('figcaption', {}, `结构 1 剖面，按比例绘制（${I.unit}）；粗短线为光阑，竖线为像面。`));
  return fig;
}

function highlight(seq) {
  const frag = document.createDocumentFragment();
  for (const line of seq.replace(/\r\n$/, '').split('\r\n')) {
    if (line.startsWith('! WARNING')) frag.append(h('span', { class: 'w' }, line));
    else if (line.startsWith('!')) frag.append(h('span', { class: 'c' }, line));
    else {
      const m = line.match(/^(\s*)(\S+)(.*)$/);
      if (m) frag.append(m[1], h('span', { class: 'k' }, m[2]), m[3]);
      else frag.append(line);
    }
    frag.append('\n');
  }
  return frag;
}

// ------------------------------------------------------------------ start
restoreOpts();
await loadGlassTable();
await loadExample('zoom_macro.zmx');
