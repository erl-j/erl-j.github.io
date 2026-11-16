/* fontview.js: letter shapes for the font view (no DOM; needs fontgen.js). A style is a level
 * between two poles of the procedural monospace font: 0 = "hand" (human style: soft, contrasted,
 * slanted, with feet, every character varied) .. LEVELS - 1 = "machine" (AI style: square, flat,
 * upright, every instance of a letter identical). Hits also get heavier with strength. Display
 * only: nothing here feeds the score. Glyphs are built lazily, one character at a time, and
 * cached by (character, level, variant, weight step). */
(function (root) {
  'use strict';
  const LEVELS = 9, VARIANTS = 6, HEAVY = 4;   // odd LEVELS: the midpoint (no score) is a level
  const HAND = { weight: 86, contrast: 0.32, stress: 20, soft: 0.8, round: 0, slant: 7, feet: 0.8, aperture: 0.75, xh: 505, ext: 0.6, vary: 0.5 };
  const MACHINE = { weight: 92, contrast: 0, stress: 0, soft: 0, round: 1, slant: 0, feet: 0, aperture: 0.45, xh: 530, ext: 0.4, vary: 0 };
  const HEAVY_W = 30;   // extra stroke weight (units per 1000 em) at full hit strength
  const ADV = 600;      // advance of the generator at width 1; glyphs are scaled to cell / ADV
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // FNV-1a, fed one UTF-16 unit at a time, so a word's prefix hashes extend as it is typed
  const HASH0 = 0x811c9dc5;
  const step = (h, c) => Math.imul(h ^ c, 0x01000193) >>> 0;
  const hashStr = (s, h = HASH0) => { for (let i = 0; i < s.length; i++) h = step(h, s.charCodeAt(i)); return h; };
  const variantOf = (h) => (Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0) % VARIANTS;
  function rng(seed) { // the generator page's per-character random stream (mulberry32)
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const levelOf = (t) => Math.round(clamp(Number.isFinite(t) ? t : 0.5, 0, 1) * (LEVELS - 1));
  const varyAt = (lv) => lerp(HAND.vary, MACHINE.vary, lv / (LEVELS - 1));

  // font parameters for one glyph; the variation follows the generator page's variant(), held still
  function params(ch, lv, vi, hv) {
    const t = lv / (LEVELS - 1);
    const Q = Object.assign({}, root.FONT_DEFAULTS, { width: 1, a: 'two', zero: 'dot' });
    for (const k of Object.keys(MACHINE)) if (k !== 'vary') Q[k] = lerp(HAND[k], MACHINE[k], t);
    Q.weight += HEAVY_W * hv / (HEAVY - 1);
    const v = varyAt(lv);
    let dy = 0;
    if (v > 0) {
      const rnd = rng(hashStr(ch) ^ Math.imul(vi + 1, 0x9E3779B1));
      const j = () => Math.sin(6.2832 * rnd()) * v;
      Q.weight = clamp(Q.weight * (1 + 0.24 * j()), 40, 150);
      Q.contrast = clamp(Q.contrast + 0.2 * j(), 0, 0.5);
      Q.stress = clamp(Q.stress + 16 * j(), -10, 35);
      Q.width = clamp(1 + 0.1 * j(), 0.8, 1.2);
      Q.xh = clamp(Q.xh + 45 * j(), 430, 585);
      Q.ext = clamp(Q.ext + 0.4 * j(), 0, 1);
      Q.round = clamp(Q.round + 0.5 * j(), 0, 1);
      Q.soft = clamp(Q.soft + 0.5 * j(), 0, 1);
      Q.aperture = clamp(Q.aperture + 0.4 * j(), 0, 1);
      Q.feet = clamp(Q.feet + 0.4 * j(), 0, 1);
      Q.slant = clamp(Q.slant + 4 * j(), 0, 12);
      dy = 40 * j();
      if (rnd() < 0.3 * v) Q.a = 'one';
      if (rnd() < 0.3 * v) Q.zero = ['dot', 'slash', 'plain'][Math.floor(rnd() * 3)];
    }
    return { Q, dy };
  }

  // The generator samples curves finely (for display sizes up to 72 px). At text size a unit is
  // ~0.016 px, so drop outline points within TOL units of the simplified outline (Ramer-Douglas-
  // Peucker per contour) and round to whole units: smaller paths, cheaper <use> instances.
  const TOL = 3;
  function simplify(d) {
    let out = '';
    for (const sub of d.split('Z')) {
      const p = [];
      for (const m of sub.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) p.push([+m[1], +m[2]]);
      if (p.length < 3) continue;
      const keep = new Uint8Array(p.length);
      keep[0] = keep[p.length - 1] = 1;
      const stack = [[0, p.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = p[a], dx = p[b][0] - ax, dy = p[b][1] - ay, l = Math.hypot(dx, dy);
        let far = -1, fd = TOL;
        for (let i = a + 1; i < b; i++) {
          const e = l > 1e-9 ? Math.abs(dx * (p[i][1] - ay) - dy * (p[i][0] - ax)) / l : Math.hypot(p[i][0] - ax, p[i][1] - ay);
          if (e > fd) { fd = e; far = i; }
        }
        if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
      }
      let s = '';
      for (let i = 0; i < p.length; i++) if (keep[i]) s += (s ? 'L' : 'M') + Math.round(p[i][0]) + ' ' + Math.round(p[i][1]);
      out += s + 'Z';
    }
    return out;
  }

  // { d, soft, adv, dy } in font units, or null when the generator has no such character
  const cache = new Map();
  function glyph(ch, lv, vi, hv) {
    if (varyAt(lv) === 0) vi = 0;
    const key = ch + '\u0001' + lv + '\u0001' + vi + '\u0001' + hv;
    let g = cache.get(key);
    if (g === undefined) {
      const { Q, dy } = params(ch, lv, vi, hv);
      const f = root.buildFont(Q, [ch]);
      g = f.glyphs[ch] === undefined ? null : { d: simplify(f.glyphs[ch]), soft: f.soft, adv: f.adv, dy };
      cache.set(key, g);
    }
    return g;
  }

  // a short label set in one style, as inline SVG markup (for the legend)
  function specimen(text, lv, px) {
    const s = px / 1000, a = ADV * s, up = 820 * s, h = up + 260 * s;
    let out = '', h0 = hashStr(text);
    [...text].forEach((ch, i) => {
      h0 = step(h0, ch.charCodeAt(0));
      const g = ch.trim() && glyph(ch, lv, variantOf(h0), 0);
      if (!g) return;
      out += `<path d="${g.d}" stroke-width="${g.soft.toFixed(1)}" transform="translate(${(i * a + (ADV - g.adv) * s / 2).toFixed(2)} ${(up - g.dy * s).toFixed(2)}) scale(${s})"/>`;
    });
    const w = (a * [...text].length).toFixed(1);
    return `<svg class="lg-spec" aria-hidden="true" focusable="false" width="${w}" height="${h.toFixed(1)}" viewBox="0 0 ${w} ${h.toFixed(1)}">` +
      `<g fill="currentColor" stroke="currentColor" stroke-linejoin="round">${out}</g></svg>`;
  }

  root.SlopFont = { LEVELS, VARIANTS, HEAVY, ADV, HAND, MACHINE, HEAVY_W, HASH0, step, hashStr, variantOf, levelOf, varyAt, params, simplify, glyph, cache, specimen };
})(globalThis);
