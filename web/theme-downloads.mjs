// Saving theme packages from the browser: one PNG, or a ZIP in the SD card layout.
import { createThemeZip } from '../src/zip.mjs';

const PACKAGE_DIR = '../assets/themes/';

export function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function allThemeFiles() {
  const response = await fetch(`${PACKAGE_DIR}index.json`);
  if (!response.ok) throw new Error(`Could not list themes: ${response.status}`);
  return response.json();
}

/** Fetch packages unchanged and zip them, reporting (done, total) as they arrive. */
export async function zipThemes(files, onProgress) {
  const themes = new Array(files.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < files.length) {
      const index = next++, file = files[index];
      const response = await fetch(PACKAGE_DIR + file);
      if (!response.ok) throw new Error(`Could not download ${file}: ${response.status}`);
      themes[index] = { file, data: new Uint8Array(await response.arrayBuffer()) };
      onProgress?.(++done, files.length);
    }
  }));
  return createThemeZip(themes);
}
