import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { crc32, makeZip } from '../web/zip.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

// read back a stored (or deflated) zip written by makeZip, without any zip library
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054B50);
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014B50);
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    assert.equal(dv.getUint32(off, true), 0x04034B50);
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    let data = buf.subarray(start, start + csize);
    if (method === 8) data = inflateRawSync(data);
    assert.equal(crc32(data), crc);
    out.push({ name, text: new TextDecoder().decode(data) });
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

test('makeZip writes a readable archive with UTF-8 names', () => {
  const enc = new TextEncoder();
  const zip = makeZip([
    { name: 'A2628.seq', bytes: enc.encode('RDM;LEN\r\nGO\r\n') },
    { name: '测试镜头.seq', bytes: enc.encode('TITLE \'x\'\r\n') },
  ], new Date(2026, 9, 20, 10, 30, 0));
  const files = readZip(zip);
  assert.deepEqual(files.map(f => f.name), ['A2628.seq', '测试镜头.seq']);
  assert.equal(files[0].text, 'RDM;LEN\r\nGO\r\n');
});
