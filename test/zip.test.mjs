import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.mjs';
import { createZip, createThemeZip } from '../src/zip.mjs';

function readZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const size = view.getUint32(at + 24, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    assert.equal(view.getUint16(at + 10, true), 0, `${name} is stored`);
    assert.equal(view.getUint32(at + 16, true), crc32(data), `${name} CRC`);
    entries.push({ name, data, date: view.getUint16(at + 14, true), localDate: view.getUint16(local + 12, true) });
    at += 46 + nameLength;
  }
  return entries;
}

test('zip archives round-trip stored entries', () => {
  const entries = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/empty', data: new Uint8Array() }];
  const read = readZip(createZip(entries));
  assert.deepEqual(read.map(e => e.name), ['a.txt', 'dir/empty']);
  assert.deepEqual([...read[0].data], [...entries[0].data]);
  assert.equal(read[1].data.length, 0);
});

test('theme zips use the SD card layout and are reproducible', () => {
  const themes = [{ file: 'water.png', data: new Uint8Array([1, 2, 3]) }];
  const zip = createThemeZip(themes);
  assert.equal(readZip(zip)[0].name, 'menu/themes/water.png');
  assert.deepEqual(createThemeZip(themes), zip);
  const { date, localDate } = readZip(zip)[0];
  assert.deepEqual([(date >> 9) + 1980, date >> 5 & 15, date & 31], [2026, 11, 1]);
  assert.equal(localDate, date);
});
