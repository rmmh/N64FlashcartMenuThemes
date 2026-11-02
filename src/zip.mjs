// Minimal ZIP writer. Entries are stored, not deflated, because theme PNGs are
// already compressed. Timestamps are fixed, so equal input gives equal bytes.
import { crc32 } from './crc32.mjs';

const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 11 << 5 | 1; // 2026-11-01 00:00

/** Build a ZIP archive from [{ name, data: Uint8Array }]. */
export function createZip(entries) {
  const encoder = new TextEncoder();
  const records = entries.map(({ name, data }) => ({ name: encoder.encode(name), data, crc: crc32(data) }));
  const size = records.reduce((sum, r) => sum + 30 + r.name.length + r.data.length + 46 + r.name.length, 22);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  let offset = 0;
  const u16 = value => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = value => { view.setUint32(offset, value, true); offset += 4; };
  const bytes = value => { out.set(value, offset); offset += value.length; };
  // Fields shared by local and central headers, from "version needed" to the name length.
  const common = r => { u16(10); u16(0x0800); u16(0); u16(DOS_TIME); u16(DOS_DATE); u32(r.crc); u32(r.data.length); u32(r.data.length); u16(r.name.length); };
  for (const r of records) {
    r.offset = offset;
    u32(0x04034b50); common(r); u16(0); bytes(r.name); bytes(r.data);
  }
  const directory = offset;
  for (const r of records) {
    u32(0x02014b50); u16(10); common(r); u16(0); u16(0); u16(0); u16(0); u32(0); u32(r.offset); bytes(r.name);
  }
  const directorySize = offset - directory;
  u32(0x06054b50); u16(0); u16(0); u16(records.length); u16(records.length); u32(directorySize); u32(directory); u16(0);
  return out;
}

export const THEME_ZIP_NAME = 'n64-menu-themes.zip';

/** Zip theme packages [{ file, data }] in the SD card layout, for extracting into the card's root. */
export function createThemeZip(themes) {
  return createZip(themes.map(({ file, data }) => ({ name: `menu/themes/${file}`, data })));
}
