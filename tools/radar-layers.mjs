// Recover stationary clutter and fixed contact sprites from generated cells.
export function fixedRadarLayers(cells, keyframes, base, profiles, timeline, size) {
  const radius = size / 2, original = base.slice(), contacts = [];
  const profileAt = (i, x, y, c) => {
    const a = ((Math.atan2(x + .5 - radius, radius - y - .5) * 360 / Math.PI) % 720 + 720) % 720;
    return profiles?.[i][Math.floor(a) * 3 + c] ?? 0;
  };
  const cloud = new Float32Array(size * size).fill(1);
  if (timeline.cloudGain && profiles) {
    const raw = cloud.slice();
    for (let p = 0; p < raw.length; p++) {
      const x = p % size, y = Math.floor(p / size);
      if ((timeline.contacts ?? []).some(([cx, cy]) => Math.hypot(x + .5 - radius * (1 + cx), y + .5 - radius * (1 + cy)) < 32)) continue;
      let brightest = 15, ratio = 1;
      for (let i = 0; i < cells.length; i++) {
        const signal = profileAt(i, x, y, 1);
        if (signal > brightest) {
          brightest = signal;
          ratio = Math.max(.35, Math.min(1.8, (cells[i].data[p * 4 + 1] - original[p * 3 + 1]) / signal));
        }
      }
      raw[p] = ratio;
    }
    // Smooth fine phosphor grain into cloud clutter in fixed screen coordinates.
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sum = 0, n = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < size && yy < size) { sum += raw[yy * size + xx]; n++; }
      }
      cloud[y * size + x] = 1 + timeline.cloudGain * (sum / n - 1);
    }
  }
  for (const spec of timeline.contactSprites ?? []) {
    const i = keyframes.findIndex(k => k.cell === spec.cell);
    if (i < 0) throw new Error('contact sprite cell is missing from timeline');
    const ax = radius * (1 + spec.x) - .5, ay = radius * (1 + spec.y) - .5;
    const peaks = cells.map(f => {
      let peak = 0, x = 0, y = 0;
      for (let yy = Math.max(0, Math.floor(ay - 22)); yy < Math.min(size, ay + 22); yy++)
        for (let xx = Math.max(0, Math.floor(ax - 22)); xx < Math.min(size, ax + 22); xx++) {
          const p = yy * size + xx;
          // Bright pale contact cores have much more red than the green beam.
          const score = f.data[p * 4] - original[p * 3];
          if (score > peak) { peak = score; x = xx; y = yy; }
        }
      return { peak, x, y };
    });
    const source = peaks[i], min = Math.min(...peaks.map(p => p.peak)), max = Math.max(...peaks.map(p => p.peak));
    const levels = peaks.map(p => max === min ? (max ? 1 : 0) : Math.max(0, (p.peak - min) / (max - min)));
    const spriteRadius = 10, sprite = new Float32Array((spriteRadius * 2 + 1) ** 2 * 3);
    for (let dy = -spriteRadius; dy <= spriteRadius; dy++) for (let dx = -spriteRadius; dx <= spriteRadius; dx++) {
      const x = source.x + dx, y = source.y + dy, r = Math.hypot(dx, dy);
      if (x < 0 || y < 0 || x >= size || y >= size || r >= spriteRadius) continue;
      const p = y * size + x, q = ((dy + spriteRadius) * (spriteRadius * 2 + 1) + dx + spriteRadius) * 3;
      for (let c = 0; c < 3; c++) sprite[q + c] = Math.max(0, cells[i].data[p * 4 + c] - original[p * 3 + c] - profileAt(i, x, y, c)) * Math.min(1, (spriteRadius - r) / 2);
    }
    // Erase all shifted copies in the static plate, preserving concentric rings
    // by sampling clean pixels at the same radius on either side of the contact.
    for (let y = Math.max(0, Math.floor(ay - 32)); y < Math.min(size, ay + 32); y++)
      for (let x = Math.max(0, Math.floor(ax - 32)); x < Math.min(size, ax + 32); x++) {
        const d = Math.hypot(x - ax, y - ay);
        if (d >= 32) continue;
        const dx = x + .5 - radius, dy = y + .5 - radius;
        const weight = Math.min(1, (32 - d) / 5);
        for (let c = 0; c < 3; c++) {
          const values = [-.28, -.22, .22, .28].map(a => {
            const xx = Math.max(0, Math.min(size - 1, Math.round(dx * Math.cos(a) - dy * Math.sin(a) + radius - .5)));
            const yy = Math.max(0, Math.min(size - 1, Math.round(dx * Math.sin(a) + dy * Math.cos(a) + radius - .5)));
            return original[(yy * size + xx) * 3 + c];
          }).sort((a, b) => a - b);
          base[(y * size + x) * 3 + c] = base[(y * size + x) * 3 + c] * (1 - weight) + (values[1] + values[2]) / 2 * weight;
        }
      }
    let x = source.x, y = source.y;
    if (spec.rangeRadius !== undefined) {
      const dx = x + .5 - radius, dy = y + .5 - radius;
      const scale = spec.rangeRadius / Math.hypot(dx, dy);
      x = Math.round(radius - .5 + dx * scale);
      y = Math.round(radius - .5 + dy * scale);
    }
    const peakLight = Math.max(...sprite);
    const opacity = Float32Array.from({ length: (spriteRadius * 2 + 1) ** 2 }, (_, p) =>
      peakLight ? Math.min(1, Math.max(...sprite.subarray(p * 3, p * 3 + 3)) / peakLight) ** .7 : 0);
    if (peakLight) opacity[spriteRadius * (spriteRadius * 2 + 1) + spriteRadius] = 1;
    contacts.push({ x, y, radius: spriteRadius, sprite, opacity, levels });
  }
  return { cloud, contacts };
}

/** Preserve the extracted core/halo silhouette using stable phosphor coverage. */
export function contactAtPixel(contacts, x, y, width) {
  for (const s of contacts) {
    const sx = x - s.x + s.radius, sy = y - s.y + s.radius, side = s.radius * 2 + 1;
    if (sx < 0 || sy < 0 || sx >= side || sy >= side) continue;
    const opacity = s.opacity[sy * side + sx];
    if (!opacity) continue;
    let hash = Math.imul(y * width + x + 1, 0x9e3779b1);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    const threshold = ((hash ^ (hash >>> 13)) >>> 0) / 4294967296;
    if (threshold < opacity) return s;
  }
  return null;
}

/** Causal phosphor response; guard against palette blending starting a flash early. */
export function contactBrightness(contact, angle, timeline, frameCount) {
  const radius = timeline.scope.radius;
  const bearing = (Math.atan2(contact.x + .5 - radius, radius - contact.y - .5) * 180 / Math.PI + 360) % 360;
  const elapsedTicks = ((angle - bearing + 360) % 360) / 360 * frameCount * timeline.stepTicks;
  // A zero entry precedes the flash so interpolation cannot illuminate the
  // contact until the beam has crossed its bearing. Delay is at most one step.
  const sinceHit = elapsedTicks - (timeline.contactPaletteStepTicks ?? timeline.stepTicks);
  if (sinceHit < 0) return 0;
  const hold = timeline.contactHoldTicks ?? 6, fade = timeline.contactFadeTicks ?? 72;
  if (sinceHit < hold) return 1;
  const u = (sinceHit - hold) / fade;
  if (u >= 1) return 0;
  // Fast initial phosphor decay with a visible, gradual tail.
  return Math.exp(-2.2 * u) * (1 - u);
}

/** A shared crisp head followed by the image-derived phosphor decay. */
export function crispSweepRamps(centers, tailDegrees) {
  const n = centers[0].length / 3, tail = Math.ceil(tailDegrees / 360 * n);
  const head = [0, 1, 2].map(c => Math.max(...centers.flatMap(v => Array.from({ length: n }, (_, j) => v[j * 3 + c]))));
  const source = Float32Array.from({ length: n * 3 }, (_, j) => centers.reduce((sum, v) => sum + v[j], 0) / centers.length);
  const curve = source.slice();
  for (let c = 0; c < 3; c++) {
    const dark = Array.from({ length: Math.floor(n / 3) }, (_, j) => source[(j + Math.floor(n / 4)) * 3 + c]).sort((a, b) => a - b);
    const base = dark[Math.floor(dark.length / 2)];
    for (let j = 0; j < n; j++) curve[j * 3 + c] = base;
    curve[c] = head[c];
    let previous = head[c];
    for (let k = 1; k <= tail; k++) {
      previous = Math.min(previous, Math.max(base, source[(n - k) * 3 + c]));
      curve[(n - k) * 3 + c] = previous;
    }
  }
  for (let i = 0; i < centers.length; i++) {
    centers[i].set(curve);
    // Adjacent fade samples may be stippled behind the head. Both variants
    // retain exactly the same head and dark leading side, so its edge stays
    // a straight ray regardless of the pixel's dither choice.
    if (i) for (let k = 1; k <= tail; k++) for (let c = 0; c < 3; c++)
      centers[i][(n - k) * 3 + c] = curve[(n - k - 1) * 3 + c];
  }
}

/** Contact palette contains no sweep illumination ahead of the hit. */
export function causalContactRamp(centers, stepTicks, holdTicks, fadeTicks, background) {
  for (const v of centers) {
    const n = v.length / 3;
    const base = background ?? [0, 1, 2].map(c => {
      const values = Array.from({ length: Math.floor(n / 3) }, (_, j) => v[(j + Math.floor(n / 4)) * 3 + c]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    });
    const peak = [0, 1, 2].map(c => Math.max(...Array.from({ length: n }, (_, j) => v[j * 3 + c])));
    const gain = 255 / Math.max(1, peak[1]);
    const head = peak.map(x => Math.min(255, x * gain));
    for (let j = 0; j < n; j++) for (let c = 0; c < 3; c++) v[j * 3 + c] = base[c];
    for (let k = 0; k * stepTicks < holdTicks + fadeTicks; k++) {
      const u = Math.max(0, (k * stepTicks - holdTicks) / fadeTicks);
      const brightness = Math.exp(-2.2 * u) * (1 - u);
      for (let c = 0; c < 3; c++) v[((n - k) % n) * 3 + c] = base[c] + (head[c] - base[c]) * brightness;
    }
  }
}
