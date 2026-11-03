#!/usr/bin/env node
// Copies the web editor and everything it loads into one folder (default
// out/site) that any static host can serve: upload its contents as-is.
// web/ becomes the site root, so its ../src and ../assets paths are rewritten
// to sit beside it. The theme index is regenerated so the gallery lists every
// package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'out/site'));
execFileSync(process.execPath, [path.join(root, 'tools/build-theme-index.mjs')], { stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
const copy = (from, filter = () => true, to = from) => fs.cpSync(path.join(root, from), path.join(out, to), {
  recursive: true, filter: src => fs.statSync(src).isDirectory() || filter(src),
});
copy('web', undefined, '.');
for (const file of fs.readdirSync(out).filter(f => f.endsWith('.mjs'))) {
  const target = path.join(out, file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/(['"`])\.\.\/(src|assets)\//g, '$1./$2/'));
}
copy('src', f => f.endsWith('.mjs'));
copy('assets/themes', f => /\.(png|json)$/.test(f));
// Drop folders the filters emptied.
const prune = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
  if (dir !== out && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
};
prune(out);

let files = 0, bytes = 0;
const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } };
walk(out);
console.log(`static site: ${out} (${files} files, ${(bytes / 1048576).toFixed(1)} MB)`);
