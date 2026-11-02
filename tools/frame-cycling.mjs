// Compile registered artwork frames into type-12 palette orbits.
// Animation timing comes from each pixel's observed RGB history.
import { consoleColor, indexImage, kmeans, nearestIndex } from '../src/palette-tools.mjs';

const distance = (a, b) => {
  let d = 0;
  for (let j = 0; j < a.length; j++) d += (a[j] - b[j]) ** 2;
  return d;
};
const closest = (v, centers) => {
  let best = 0, error = Infinity;
  centers.forEach((c, i) => { const d = distance(v, c); if (d < error) { best = i; error = d; } });
  return best;
};

/** Each cluster is a complete RGB trajectory, aligned at its brightest frame. */
export function compileFrameCycling(frames, { clusters = 8, stepTicks = 12, threshold = 20,
  groupForPixel = () => 0, groupClusters = [clusters], groupFrameCounts,
  phaseForPixel, transformCenters, centerForPixel,
  forceFixed = () => false, fixedColorForPixel } = {}) {
  const n = frames.length, first = frames[0];
  const counts = groupFrameCounts ?? groupClusters.map(() => n);
  if (!first || n < 2 || n > 255) throw new Error('need 2..255 frames');
  if (frames.some(f => f.width !== first.width || f.height !== first.height || f.data.length !== first.width * first.height * 4))
    throw new Error('frames must have identical dimensions');
  if (!Number.isInteger(clusters) || clusters < 1 || clusters > 16 ||
      groupClusters.reduce((sum, k, i) => sum + k * counts[i], 0) >= 256)
    throw new Error('palette budget must leave fixed colors and allow at most 16 ranges');
  if (!Number.isInteger(stepTicks) || stepTicks < 1 || stepTicks > 65535)
    throw new Error('stepTicks must be 1..65535');
  if (groupClusters.some(n => !Number.isInteger(n) || n < 1) || groupClusters.reduce((a, b) => a + b, 0) !== clusters)
    throw new Error('group cluster budgets must sum to clusters');
  if (counts.length !== groupClusters.length || counts.some(k => !Number.isInteger(k) || k < 2 || n % k || stepTicks * n / k > 65535))
    throw new Error('group frame counts must divide the source frame count');
  const count = first.width * first.height, peaks = new Uint8Array(count), moving = [], fixed = [];
  const mean = p => [0, 1, 2].map(c => frames.reduce((s, f) => s + f.data[p * 4 + c], 0) / n);
  const trajectory = p => {
    const length = counts[groupForPixel(p)], stride = n / length;
    const v = new Float32Array(length * 3), peak = peaks[p];
    // Entry peak-t must reproduce frame t under the console's forward rotation.
    for (let j = 0; j < length; j++) {
      const f = frames[((peak - j + length) % length) * stride];
      for (let c = 0; c < 3; c++) v[j * 3 + c] = f.data[p * 4 + c];
    }
    return v;
  };
  for (let p = 0; p < count; p++) {
    const group = groupForPixel(p);
    if (!Number.isInteger(group) || counts[group] === undefined) throw new Error('invalid pixel group');
    const stride = n / counts[group];
    let min = Infinity, max = -Infinity;
    frames.forEach((f, t) => {
      if (t % stride) return;
      const q = p * 4, l = .2126 * f.data[q] + .7152 * f.data[q + 1] + .0722 * f.data[q + 2];
      if (l > max) { max = l; peaks[p] = t / stride; }
      min = Math.min(min, l);
    });
    if (phaseForPixel) {
      const phase = phaseForPixel(p, group, counts[group]);
      if (!Number.isInteger(phase) || phase < 0 || phase >= counts[group]) throw new Error('invalid pixel phase');
      peaks[p] = phase;
    }
    if (!forceFixed(p) && max - min > threshold) moving.push(p);
    else fixed.push(fixedColorForPixel ? fixedColorForPixel(p) : mean(p));
  }
  if (!moving.length) throw new Error('frames contain no changing pixels above threshold');
  const stride = Math.max(1, Math.ceil(moving.length / 4096));
  const samplesByGroup = groupClusters.map(() => []);
  for (let i = 0; i < moving.length; i += stride) {
    const p = moving[i], group = groupForPixel(p);
    if (!Number.isInteger(group) || !samplesByGroup[group]) throw new Error('invalid pixel group');
    samplesByGroup[group].push(trajectory(p));
  }
  const centers = [], centerGroups = [];
  for (let group = 0; group < groupClusters.length; group++) {
    const samples = samplesByGroup[group];
    if (!samples.length) continue;
    // Deterministic farthest-point seeds retain small, bright contact trajectories.
    const fitted = [samples.reduce((a, b) => b[1] > a[1] ? b : a).slice()];
    while (fitted.length < Math.min(groupClusters[group], samples.length)) {
      let pick = samples[0], farthest = -1;
      for (const v of samples) {
        const d = distance(v, fitted[closest(v, fitted)]);
        if (d > farthest) { farthest = d; pick = v; }
      }
      if (farthest === 0) break;
      fitted.push(pick.slice());
    }
    for (let pass = 0; pass < 10; pass++) {
      const sums = fitted.map(() => new Float64Array(counts[group] * 3)), weights = fitted.map(() => 0);
      for (const v of samples) {
        const c = closest(v, fitted); weights[c]++;
        for (let j = 0; j < v.length; j++) sums[c][j] += v[j];
      }
      fitted.forEach((c, i) => { if (weights[i]) for (let j = 0; j < c.length; j++) c[j] = sums[i][j] / weights[i]; });
    }
    if (transformCenters) transformCenters(fitted, group);
    centers.push(...fitted);
    centerGroups.push(...fitted.map(() => group));
  }
  const groupedClosest = (v, group) => {
    let best = -1, error = Infinity;
    for (let i = 0; i < centers.length; i++) if (centerGroups[i] === group) {
      const d = distance(v, centers[i]);
      if (d < error) { best = i; error = d; }
    }
    if (best < 0) throw new Error('pixel group has no training samples');
    return best;
  };
  const colors = [], ranges = [];
  for (let i = 0; i < centers.length; i++) {
    const v = centers[i], length = counts[centerGroups[i]];
    ranges.push({ start: colors.length, length, stepTicks: stepTicks * n / length, flags: 2 });
    for (let j = 0; j < length; j++) colors.push(consoleColor(Array.from(v.subarray(j * 3, j * 3 + 3))));
  }
  const fixedStart = colors.length;
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(count), active = new Uint8Array(count);
  let squaredError = 0, components = 0;
  for (const p of moving) {
    active[p] = 1;
    const v = trajectory(p), group = groupForPixel(p);
    const allowed = centers.map((_, i) => i).filter(i => centerGroups[i] === group);
    const c = centerForPixel ? centerForPixel(p, group, allowed) : groupedClosest(v, group);
    const shift = peaks[p];
    const range = ranges[c];
    indices[p] = range.start + shift;
    for (let j = 0; j < range.length; j++) for (let ch = 0; ch < 3; ch++) {
      const at = (j + shift - peaks[p] + range.length) % range.length;
      squaredError += (v[j * 3 + ch] - colors[range.start + at][ch]) ** 2;
      components++;
    }
  }
  for (let p = 0; p < count; p++) if (!active[p])
    indices[p] = nearestIndex(colors, fixedStart, colors.length - fixedStart, fixedColorForPixel ? fixedColorForPixel(p) : mean(p));
  return {
    image: indexImage(first.width, first.height, indices), colors, ranges,
    report: { frameCount: n, movingPixels: moving.length, fixedColors: colors.length - fixedStart,
      ranges: ranges.length, cycleSeconds: n * stepTicks / 60,
      movingRgbRms: Math.sqrt(squaredError / components) },
  };
}
