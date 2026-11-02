// Shared output guard for the SD-card theme builders: a builder may only
// write packages listed in sd-themes.txt, so it can never replace another
// theme that happens to share a filename (or a name).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = new Set((await fs.readFile(path.join(root, 'sd-themes.txt'), 'utf8'))
  .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')));

/** Write a theme package to assets/themes/, refusing files outside the manifest. */
export async function writeSdTheme(file, image) {
  if (!manifest.has(file)) throw new Error(`${file} is not listed in sd-themes.txt; add it there to build it`);
  await fs.writeFile(path.join(root, 'assets/themes', file), encodePng(image));
}
