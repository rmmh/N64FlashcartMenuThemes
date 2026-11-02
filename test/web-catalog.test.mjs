import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Measured on the menu in ares: a positive Y velocity moves texture content
// down the screen (libdragon's texture translate shifts the image itself).
test('WebGL texture velocity moves content right/down for positive values, as on the console',()=>{
  const renderer=fs.readFileSync(path.join(root,'web','webgl-renderer.mjs'),'utf8');
  assert.match(renderer,/uv -= velocity \* \(time \* 480\.0\)/);
  assert.doesNotMatch(renderer,/uv \+= velocity \* \(time \* 480\.0\)/);
});

test('the static gallery index lists every theme package',()=>{
  const dir=path.join(root,'assets','themes');
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.png')).sort();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8')),files,'run node tools/build-theme-index.mjs');
});
