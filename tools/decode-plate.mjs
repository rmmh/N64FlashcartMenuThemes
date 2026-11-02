// Reads a source plate: JPEG through djpeg (libjpeg/mozjpeg), PNG natively.
// Only the theme builders need this; the format tools and editor stay
// dependency-free.
import { execFileSync } from 'node:child_process';
import { decodePng } from '../src/png-node.mjs';

function parsePpm(ppm) {
  let o = 0;
  const token = () => {
    for (;;) {
      while (ppm[o] <= 32) o++;
      if (ppm[o] !== 35) break;
      while (ppm[o] !== 10) o++;
    }
    const start = o;
    while (ppm[o] > 32) o++;
    return ppm.toString('latin1', start, o);
  };
  if (token() !== 'P6') throw new Error('djpeg did not produce RGB output');
  const width = +token(), height = +token();
  if (+token() !== 255) throw new Error('expected 8-bit output from djpeg');
  o++;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = o; i < data.length; i += 4, p += 3) {
    data[i] = ppm[p]; data[i + 1] = ppm[p + 1]; data[i + 2] = ppm[p + 2]; data[i + 3] = 255;
  }
  return { width, height, data };
}

export function decodePlate(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return decodePng(bytes);
  return parsePpm(execFileSync('djpeg', ['-pnm'], { input: bytes, maxBuffer: 1 << 30 }));
}
