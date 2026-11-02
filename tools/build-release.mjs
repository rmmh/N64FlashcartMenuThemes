#!/usr/bin/env node
// Writes every theme package to out/release/n64-menu-themes.zip, laid out to be
// extracted into the SD card root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThemeZip, THEME_ZIP_NAME } from '../src/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'assets/themes');
const themes = fs.readdirSync(dir).filter(file => file.endsWith('.png')).sort()
  .map(file => ({ file, data: fs.readFileSync(path.join(dir, file)) }));
const out = path.join(root, 'out/release', THEME_ZIP_NAME);
fs.mkdirSync(path.dirname(out), { recursive: true });
const zip = createThemeZip(themes);
fs.writeFileSync(out, zip);
console.log(`${path.relative(root, out)}: ${themes.length} themes, ${(zip.length / 1048576).toFixed(1)} MB`);
