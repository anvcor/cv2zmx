// Drop .zmx files to get .seq files, drop .seq files to get .zmx files. Default conversion
// options; the CLIs have the switches. Everything runs locally; files never leave the browser.
import { convertBytes, parseGlassTable, encodeText, ConversionError, VERSION } from './zmx2seq.js';
import { convertSeqBytes, encodeZmx, VERSION as SEQ_VERSION } from './seq2zmx.js';
import { makeZip } from './zip.js';

const $ = sel => document.querySelector(sel);
const list = $('#list');
$('#ver').textContent = `zmx2seq ${VERSION} · seq2zmx ${SEQ_VERSION}`;

// the two directions, picked by file extension
const DIRECTIONS = {
  zmx: {
    to: 'seq',
    convert: (bytes, opts) => convertBytes(bytes, opts),
    encode: res => encodeText(res.seq, 'gbk'),
    notesAt: '已写在 .seq 开头的注释里',
  },
  seq: {
    to: 'zmx',
    convert: (bytes, opts) => convertSeqBytes(bytes, opts),
    encode: res => encodeZmx(res.zmx),
    notesAt: '已写进 .zmx 的备注（NOTE）',
  },
};
const extOf = name => (name.match(/\.(zmx|seq)$/i) || [])[1]?.toLowerCase();
const stem = name => name.replace(/\.[^.]*$/, '');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// ------------------------------------------------------------------ glass map
let table = null;
const glassReady = (async () => {
  for (const p of ['CV2ZMX_GLASS.DAT', '../CV2ZMX_GLASS.DAT']) {
    try {
      const r = await fetch(p);
      if (r.ok) { table = parseGlassTable(await r.text()); return; }
    } catch { /* try the next location */ }
  }
  const n = $('#notice');
  n.textContent = '没加载到玻璃映射表 CV2ZMX_GLASS.DAT，目录玻璃会写成模型玻璃（nd/vd）。';
  n.hidden = false;
})();

// ------------------------------------------------------------------ saving
// Inside a claude.ai artifact the page cannot start downloads itself; the viewer's
// `downloads` capability takes .zip but not .seq / .zmx, so there the file goes out inside a .zip.
let viewerDownloads = null;
if (typeof window.claude?.use === 'function') {
  window.claude.use('downloads').then(ns => { viewerDownloads = ns; }).catch(() => {});
}

async function saveBytes(filename, bytes) {
  if (viewerDownloads) {
    try {
      await viewerDownloads.save({ filename, data: bytes.slice() });
      return true;
    } catch (e) {
      if (e?.code !== 'declined') toast('这里不能保存文件');
      return false;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

async function saveOne(out) {
  if (!viewerDownloads) { await saveBytes(out.name, out.bytes); return; }
  const zipName = stem(out.name) + '.zip';
  if (await saveBytes(zipName, makeZip([out]))) toast(`已保存 ${zipName}，解压出来就是 ${out.name}`);
}

async function saveAll(outs) {
  const seen = new Map();
  const files = outs.map(o => {
    const n = seen.get(o.name) || 0;
    seen.set(o.name, n + 1);
    return { name: n ? o.name.replace(/(\.[^.]*)$/, `(${n + 1})$1`) : o.name, bytes: o.bytes };
  });
  if (await saveBytes('cv2zmx.zip', makeZip(files))) toast(`${files.length} 个文件已打包成 cv2zmx.zip`);
}

// ------------------------------------------------------------------ converting
async function handle(fileList) {
  const files = [...fileList].filter(f => extOf(f.name));
  if (!files.length) { toast('请选择 .zmx 或 .seq 文件'); return; }
  await glassReady;
  const outs = [], rows = [];
  for (const f of files) {
    const dir = DIRECTIONS[extOf(f.name)];
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      const res = dir.convert(bytes, { glassTable: table, fileName: f.name });
      const out = { name: `${stem(f.name)}.${dir.to}`, bytes: dir.encode(res) };
      outs.push(out);
      rows.push(okRow(f.name, out, res, dir));
    } catch (e) {
      rows.push(h('li', { class: 'row err' },
        h('div', { class: 'names' }, h('span', { class: 'from' }, f.name)),
        h('span', {}),
        h('div', { class: 'sub' }, e instanceof ConversionError ? e.zh : `转换出错：${e.message}`)));
    }
  }
  if (outs.length > 1) {
    rows.unshift(h('li', {}, h('button', { class: 'btn all', type: 'button', onclick: () => saveAll(outs) }, `再次下载这 ${outs.length} 个（.zip）`)));
  }
  list.replaceChildren(...rows);
  if (outs.length === 1) await saveOne(outs[0]);
  else if (outs.length > 1) await saveAll(outs);
}

function okRow(inName, out, res, dir) {
  const I = res.info;
  const warns = res.warnings.filter(w => w.level === 'warn');
  const facts = `${I.surfaces} 个面 · ${I.configurations} 个结构`;
  const hints = warns.length
    ? h('details', {},
      h('summary', {}, `${warns.length} 条提示（${dir.notesAt}）`),
      h('ul', {}, warns.map(w => h('li', {}, w.zh))))
    : '全部转换';
  return h('li', { class: 'row' },
    h('div', { class: 'names' }, h('span', { class: 'from' }, inName), ' → ', h('strong', {}, out.name)),
    h('button', { class: 'btn', type: 'button', onclick: () => saveOne(out) }, '下载'),
    h('div', { class: 'sub' }, facts, ' · ', hints));
}

// ------------------------------------------------------------------ input
$('#file').addEventListener('change', e => { handle(e.target.files); e.target.value = ''; });
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer?.files?.length) handle(e.dataTransfer.files); });
