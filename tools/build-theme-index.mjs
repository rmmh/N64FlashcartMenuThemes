#!/usr/bin/env node
// Writes assets/themes/index.json, the package list the web gallery reads, so
// the editor works as a static site (e.g. GitHub Pages) without a server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets/themes');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(files, null, 1) + '\n');
console.log(`indexed ${files.length} themes`);
