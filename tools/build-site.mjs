#!/usr/bin/env node
// Copies the web editor and everything it loads into one folder (default
// out/site) that any static host can serve: upload its contents as-is.
// The editor fetches by relative paths (../src, ../assets/themes, ...), so
// the repo's layout is kept, with an index.html at the top that forwards to
// web/. The theme index is regenerated so the gallery lists every package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'out/site'));
execFileSync(process.execPath, [path.join(root, 'tools/build-theme-index.mjs')], { stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
const copy = (from, filter = () => true) => fs.cpSync(path.join(root, from), path.join(out, from), {
  recursive: true, filter: src => fs.statSync(src).isDirectory() || filter(src),
});
copy('web');
copy('src', f => f.endsWith('.mjs'));
copy('assets/themes', f => /\.(png|json)$/.test(f));
// Drop folders the filters emptied.
const prune = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
  if (dir !== out && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
};
prune(out);
fs.writeFileSync(path.join(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>NFMT theme editor</title>\n' +
  '<meta http-equiv="refresh" content="0; url=web/"><a href="web/">NFMT theme editor</a>\n');

let files = 0, bytes = 0;
const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } };
walk(out);
console.log(`static site: ${out} (${files} files, ${(bytes / 1048576).toFixed(1)} MB)`);
