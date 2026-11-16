/* fontgen.js: the project's procedural monospace font generator (first script of its page, copied verbatim).
 * buildFont(P, only) -> { adv, asc, desc, cap, xh, soft, glyphs: { char: SVG path d } }: 1000 units per em,
 * paths already flipped (y down, baseline at 0). Exposes buildFont and FONT_DEFAULTS on globalThis. */
(function (root) {
  'use strict';
  const lerp = (a, b, t) => a + (b - a) * t;

  const FONT_DEFAULTS = {
    weight: 88, contrast: 0.22, stress: 12, width: 1, xh: 520, ext: 0.5,
    round: 0.3, soft: 0.35, aperture: 0.6, feet: 0.7, slant: 0,
    a: 'two', zero: 'dot'
  };

  function buildFont(P, only) {
    const W = P.weight, con = P.contrast, phi = P.stress * Math.PI / 180;
    const K = 0.5523 + P.round * 0.27;
    const soft = P.soft * W * (1 - con) * 0.92;
    const tanS = Math.tan(P.slant * Math.PI / 180);

    // Half stroke width for a stroke travelling in direction (tx, ty).
    function hw(tx, ty) {
      const s = Math.sin(Math.atan2(ty, tx) - phi);
      return W / 2 * (1 - con * (1 - s * s));
    }

    // ---------- pen: builds one stroke skeleton ----------
    function Pen(s) { this.n = []; this.s = s || 1; this.c0 = 'flat'; this.c1 = 'flat'; }
    Pen.prototype.M = function (x, y, w) { this.n.push({ x, y, w: w == null ? 1 : w, ti: null, to: null }); return this; };
    Pen.prototype.L = function (x, y, w) {
      const a = this.n[this.n.length - 1], dx = x - a.x, dy = y - a.y, l = Math.hypot(dx, dy) || 1;
      const t = [dx / l, dy / l]; a.to = t;
      this.n.push({ x, y, w: w == null ? a.w : w, ti: t, to: null }); return this;
    };
    Pen.prototype.C = function (x1, y1, x2, y2, x, y, w) {
      const a = this.n[this.n.length - 1], w0 = a.w, w1 = w == null ? a.w : w;
      const est = Math.hypot(x1 - a.x, y1 - a.y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
      const N = Math.max(6, Math.min(40, Math.ceil(est / 9)));
      const tan = (t) => {
        const u = 1 - t;
        let dx = 3 * u * u * (x1 - a.x) + 6 * u * t * (x2 - x1) + 3 * t * t * (x - x2);
        let dy = 3 * u * u * (y1 - a.y) + 6 * u * t * (y2 - y1) + 3 * t * t * (y - y2);
        let l = Math.hypot(dx, dy);
        if (l < 1e-6) { dx = x - a.x; dy = y - a.y; l = Math.hypot(dx, dy) || 1; }
        return [dx / l, dy / l];
      };
      a.to = tan(0);
      for (let i = 1; i <= N; i++) {
        const t = i / N, u = 1 - t;
        const px = u * u * u * a.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x;
        const py = u * u * u * a.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y;
        const tg = tan(t), e = t * t * (3 - 2 * t);
        this.n.push({ x: px, y: py, w: lerp(w0, w1, e), ti: tg, to: i < N ? tg : null });
      }
      return this;
    };
    function sub(p, t0, t1) { // portion [t0, t1] of a cubic given as 4 points
      const cut = (q, t) => {
        const l = (a, b) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
        const a = l(q[0], q[1]), b = l(q[1], q[2]), c = l(q[2], q[3]), d = l(a, b), e = l(b, c), f = l(d, e);
        return [[q[0], a, d, f], [f, e, c, q[3]]];
      };
      let q = p;
      if (t1 < 1) q = cut(q, t1)[0];
      if (t0 > 0) q = cut(q, t0 / t1)[1];
      return q;
    }
    // Quarter turn from the current point to (x, y), bending round the corner (cx, cy).
    Pen.prototype.Q = function (cx, cy, x, y, o) {
      o = o || {};
      const a = this.n[this.n.length - 1], k = o.k == null ? K : o.k, k2 = o.k2 == null ? k : o.k2;
      const p = [[a.x, a.y], [a.x + k * (cx - a.x), a.y + k * (cy - a.y)], [x + k2 * (cx - x), y + k2 * (cy - y)], [x, y]];
      const q = o.t1 != null && o.t1 < 1 ? sub(p, 0, o.t1) : p;
      return this.C(q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1], o.w);
    };
    // Start a stroke part-way along a quarter turn.
    Pen.prototype.MQ = function (x0, y0, cx, cy, x, y, o) {
      o = o || {};
      const k = o.k == null ? K : o.k;
      const p = [[x0, y0], [x0 + k * (cx - x0), y0 + k * (cy - y0)], [x + k * (cx - x), y + k * (cy - y)], [x, y]];
      const q = sub(p, o.t0 || 0, 1);
      this.M(q[0][0], q[0][1], o.w0);
      return this.C(q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1], o.w);
    };
    Pen.prototype.cut = function (c0, c1) { if (c0) this.c0 = c0; if (c1) this.c1 = c1; return this; };
    const pen = (s) => new Pen(s);

    // ---------- stroke skeleton -> outline polygon ----------
    const MITER = 2.1;
    function trimmed(src, len, atEnd) {
      const ns = atEnd ? src : src.slice().reverse();
      while (ns.length > 2) {
        const a = ns[ns.length - 2], b = ns[ns.length - 1], seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (seg > len + 0.5) break;
        len -= seg; ns.pop();
      }
      const a = ns[ns.length - 2], b = ns[ns.length - 1], seg = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const q = Math.min(len, seg * 0.6);
      ns[ns.length - 1] = Object.assign({}, b, { x: b.x - (b.x - a.x) / seg * q, y: b.y - (b.y - a.y) / seg * q });
      return atEnd ? ns : ns.reverse();
    }
    function expand(p) {
      let ns = p.n.slice();
      const sc = p.s;
      const closed = ns.length > 3 && Math.hypot(ns[0].x - ns[ns.length - 1].x, ns[0].y - ns[ns.length - 1].y) < 0.5;
      if (!closed && soft > 0.5) {
        const tl = (c, t) => c === 'h' ? (soft / 2) / Math.max(0.2, Math.abs(t[1])) : c === 'v' ? (soft / 2) / Math.max(0.2, Math.abs(t[0])) : soft / 2;
        ns = trimmed(ns, tl(p.c0, ns[0].to), false);
        ns = trimmed(ns, tl(p.c1, ns[ns.length - 1].ti), true);
      }
      const last = ns.length - 1;
      const Ls = [], Rs = [];
      for (let i = 0; i <= last; i++) {
        const nd = ns[i], ti = i === 0 ? null : nd.ti, to = i === last ? null : nd.to;
        const hOf = (t) => Math.max(1.5, hw(t[0], t[1]) * nd.w * sc - soft / 2);
        if (ti && to) {
          const cross = ti[0] * to[1] - ti[1] * to[0], dt = ti[0] * to[0] + ti[1] * to[1];
          if (Math.abs(cross) < 0.03 && dt > 0) {
            const l = Math.hypot(ti[0] + to[0], ti[1] + to[1]), t = [(ti[0] + to[0]) / l, (ti[1] + to[1]) / l], h = hOf(t);
            Ls.push([nd.x - t[1] * h, nd.y + t[0] * h]); Rs.push([nd.x + t[1] * h, nd.y - t[0] * h]);
          } else {
            const hi = hOf(ti), ho = hOf(to);
            for (const s of [1, -1]) {
              const A = [nd.x - s * ti[1] * hi, nd.y + s * ti[0] * hi], Bp = [nd.x - s * to[1] * ho, nd.y + s * to[0] * ho];
              const a = ((Bp[0] - A[0]) * to[1] - (Bp[1] - A[1]) * to[0]) / cross;
              const Mp = [A[0] + a * ti[0], A[1] + a * ti[1]];
              const inner = (cross > 0) === (s > 0);
              const far = Math.hypot(Mp[0] - nd.x, Mp[1] - nd.y) > MITER * Math.max(hi, ho);
              const out = s > 0 ? Ls : Rs;
              if (inner || !far) out.push(Mp); else { out.push(A); out.push(Bp); }
            }
          }
        } else {
          const t = ti || to, start = i === 0, h = hOf(t), c = start ? p.c0 : p.c1;
          const px = nd.x, py = nd.y;
          let aL = 0;
          if (c === 'h' && Math.abs(t[1]) > 0.15) aL = -t[0] * h / t[1];
          else if (c === 'v' && Math.abs(t[0]) > 0.15) aL = t[1] * h / t[0];
          Ls.push([px - t[1] * h + t[0] * aL, py + t[0] * h + t[1] * aL]);
          Rs.push([px + t[1] * h - t[0] * aL, py - t[0] * h - t[1] * aL]);
        }
      }
      return Ls.concat(Rs.reverse());
    }

    function dot(x, y, rx, ry) {
      const a = Math.max(1, rx - soft / 2), b = Math.max(1, (ry == null ? rx : ry) - soft / 2), pts = [];
      for (let i = 0; i < 30; i++) { const t = -i / 30 * 2 * Math.PI; pts.push([x + a * Math.cos(t), y + b * Math.sin(t)]); }
      return { poly: pts };
    }

    // ---------- metrics ----------
    const adv = Math.round(600 * P.width), cx = adv / 2;
    const hv = hw(0, 1), hh = hw(1, 0);
    const xh = P.xh, cap = 690, asc = 730 + 60 * P.ext, desc = -(165 + 75 * P.ext), os = 10;
    const sb = 0.113 * adv, sbr = 0.09 * adv;
    const L = sb + hv, R = adv - sb - hv, Lr = sbr + hv, Rr = adv - sbr - hv;
    const T = xh - hh, To = xh + os - hh, B = hh, Bo = hh - os;
    const Tc = cap - hh, Tco = cap + os - hh, At = asc - hh;
    const sbc = 0.095 * adv, sbcr = 0.075 * adv;
    const Lc = sbc + hv, Rc = adv - sbc - hv, Lcr = sbcr + hv, Rcr = adv - sbcr - hv;
    const mc = cap / 2, Dz = desc + hh;
    const te = lerp(0.86, 0.42, P.aperture);
    const ft = P.feet, a_ = adv;
    const dr = W * 0.6, pr = W * 0.68;
    const dotY = xh + Math.max(dr * 1.9, (asc - xh) * 0.62);

    // ---------- shared shapes ----------
    const oval = (l, r, b, t, s) => { const c = (l + r) / 2, m = (b + t) / 2; return pen(s).M(c, t).Q(r, t, r, m).Q(r, b, c, b).Q(l, b, l, m).Q(l, t, c, t); };
    const bowlR = (l, r, b, t) => { const c = (l + r) / 2 + 0.04 * (r - l), h = t - b; return pen().M(l, b + h * 0.6, 0.55).Q(l, t, c, t, { w: 1, k: 0.5 }).Q(r, t, r, b + h / 2).Q(r, b, c, b).Q(l, b, l, b + h * 0.4, { w: 0.55, k2: 0.5 }); };
    const bowlL = (l, r, b, t) => { const c = (l + r) / 2 - 0.04 * (r - l), h = t - b; return pen().M(r, b + h * 0.6, 0.55).Q(r, t, c, t, { w: 1, k: 0.5 }).Q(l, t, l, b + h / 2).Q(l, b, c, b).Q(r, b, r, b + h * 0.4, { w: 0.55, k2: 0.5 }); };
    const arch = (l, r, s, y0) => { const c = l + (r - l) * 0.52, sh = To - (r - c) * 1.1; return pen(s).M(l, y0 == null ? xh * 0.56 : y0, 0.55).Q(l, To, c, To, { w: 1, k: 0.5 }).Q(r, To, r, sh).L(r, 0); };
    const ess = (l, r, b, t, s) => {
      const h = t - b, c = (l + r) / 2, lu = l + 0.035 * (r - l), ru = r - 0.05 * (r - l), y1 = b + h * 0.745, y2 = b + h * 0.265;
      return pen(s).MQ(ru, y1, ru, t, c, t, { t0: 1 - te }).Q(lu, t, lu, y1).C(lu, y1 - h * 0.27, r, y2 + h * 0.29, r, y2).Q(r, b, c, b).Q(l, b, l, y2, { t1: te });
    };
    const cee = (l, r, b, t) => { const c = (l + r) / 2 + 0.03 * (r - l), m = (b + t) / 2; return pen().MQ(r, m, r, t, c, t, { t0: 1 - te }).Q(l, t, l, m).Q(l, b, c, b).Q(r, b, r, m, { t1: te }); };
    // Straight diagonal whose ends are cut level. sa / sb_: -1, 0, +1 = x names the left edge, centre, right edge.
    function dg(xa, ya, sa, xb, yb, sb_, o) {
      o = o || {}; const s = o.s || 1; let ax = xa, bx = xb;
      for (let i = 0; i < 3; i++) {
        const dx = bx - ax, dy = yb - ya, l = Math.hypot(dx, dy), f = hw(dx / l, dy / l) * s / Math.abs(dy / l);
        ax = xa - sa * f; bx = xb - sb_ * f;
      }
      const p = pen(s).M(ax, ya).L(bx, yb); p.c0 = o.c0 || 'h'; p.c1 = o.c1 || 'h'; return p;
    }
    const xAt = (p, y) => { const a = p.n[0], b = p.n[1]; return a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y); };
    const stem = (x, y0, y1, s) => pen(s).M(x, y0).L(x, y1);
    const bar = (x0, x1, y, s) => pen(s).M(x0, y).L(x1, y);
    const rot = (p, h) => { for (const n of p.n) { n.x = adv - n.x; n.y = h - n.y; if (n.ti) n.ti = [-n.ti[0], -n.ti[1]]; if (n.to) n.to = [-n.to[0], -n.to[1]]; } return p; };
    const comma = (x, y, up) => {
      const d = up ? -1 : 1, q = pr * 0.93;
      return [dot(x, y, q), pen().M(x + d * q * 0.52, y + d * q * 0.1, 0.95).C(x + d * q * 0.62, y - d * q * 1.15, x + d * q * 0.2, y - d * q * 1.9, x - d * q * 0.8, y - d * q * 2.45, 0.38)];
    };
    const flagStem = (x, top, bot, f) => f > 0.03 * a_ ? pen().M(x - f, top - hh).L(x, top - hh).L(x, bot) : stem(x, top, bot);

    // ---------- glyphs ----------
    const G = {
      ' ': () => [],
      a: () => {
        if (P.a !== 'two') return [stem(R, 0, xh), bowlL(Lr, R, Bo, To)];
        const c = (L + R) / 2 + 0.01 * a_, la = L + 0.02 * a_, yb = xh * 0.565, cb = (L + R) / 2 - 0.01 * a_, lb = Lr + 0.015 * a_;
        return [
          pen().M(R, 0).L(R, To - (R - c) * 1.05).Q(R, To, c, To).Q(la, To, la, To - (c - la) * 1.05, { t1: te * 0.92 }),
          pen().M(R, yb).L(cb + 0.04 * a_, yb).Q(lb, yb, lb, (yb + Bo) / 2, { k: 0.62 }).Q(lb, Bo, cb, Bo).Q(R, Bo, R, xh * 0.36, { w: 0.55, k2: 0.5 })
        ];
      },
      b: () => [stem(L, 0, asc), bowlR(L, Rr, Bo, To)],
      c: () => [cee(Lr, Rr - 0.015 * a_, Bo, To)],
      d: () => [stem(R, 0, asc), bowlL(Lr, R, Bo, To)],
      e: () => {
        const ym = xh * 0.515, c = (Lr + Rr) / 2 + 0.005 * a_;
        return [
          pen().M(Rr, ym - hh).Q(Rr, To, c, To).Q(Lr, To, Lr, xh / 2).Q(Lr, Bo, c + 0.01 * a_, Bo).Q(Rr - 0.01 * a_, Bo, Rr - 0.01 * a_, xh * 0.47, { t1: te * 0.9 }),
          bar(Lr, Rr, ym)
        ];
      },
      f: () => {
        const x = cx - 0.045 * a_, rf = 0.2 * a_, re = R + 0.03 * a_, top = At + os * 0.5;
        return [
          pen().M(x, 0).L(x, top - rf * 1.05).Q(x, top, x + rf, top).Q(re, top, re, top - (re - x - rf), { t1: 0.42 }),
          bar(L - 0.05 * a_, R + 0.01 * a_, T)
        ];
      },
      g: () => {
        const c = cx - 0.01 * a_, lg = L + 0.005 * a_;
        return [bowlL(Lr, R, Bo, To), pen().M(R, xh).L(R, Dz + (R - c) * 0.95).Q(R, Dz, c, Dz).Q(lg, Dz, lg, Dz + (c - lg) * 0.9, { t1: te * 0.85 })];
      },
      h: () => [stem(L, 0, asc), arch(L, R)],
      i: () => {
        const x = cx + 0.012 * a_;
        return [flagStem(x, xh, 0, ft * 0.36 * a_), ft > 0.1 ? bar(x - ft * 0.38 * a_, x + ft * 0.38 * a_, B) : null, dot(x - 0.012 * a_ * ft, dotY, dr)];
      },
      j: () => {
        const x = cx + 0.09 * a_, rj = 0.25 * a_, f = ft * 0.36 * a_;
        const p = f > 0.03 * a_ ? pen().M(x - f, T).L(x, T) : pen().M(x, xh);
        return [p.L(x, Dz + rj).Q(x, Dz, x - rj, Dz).L(L + 0.01 * a_, Dz), dot(x - 0.012 * a_ * ft, dotY, dr)];
      },
      k: () => {
        const arm = dg(adv - sb * 0.85, xh, 1, L, xh * 0.37, 0, { c1: 'flat' }), a = arm.n[1], b = arm.n[0];
        return [stem(L, 0, asc), arm, dg(lerp(a.x, b.x, 0.34), lerp(a.y, b.y, 0.34), 0, adv - sb * 0.7, 0, 1, { c0: 'flat' })];
      },
      l: () => {
        const x = cx - 0.03 * a_, rl = 0.2 * a_, f = ft * 0.36 * a_;
        const p = f > 0.03 * a_ ? pen().M(x - f, At).L(x, At) : pen().M(x, asc);
        return [p.L(x, B + rl).Q(x, B, x + rl, B).L(R + 0.035 * a_, B)];
      },
      m: () => {
        const l = sb * 0.5 + hv * 0.88, r = adv - l, s = 0.88;
        return [stem(l, 0, xh, s), arch(l, cx, s, xh * 0.62), arch(cx, r, s, xh * 0.62)];
      },
      n: () => [stem(L, 0, xh), arch(L, R)],
      o: () => [oval(Lr, Rr, Bo, To)],
      p: () => [stem(L, desc, xh), bowlR(L, Rr, Bo, To)],
      q: () => [stem(R, desc, xh), bowlL(Lr, R, Bo, To)],
      r: () => {
        const x = L + lerp(0.045, 0.085, ft) * a_, ra = x + (R - x) * 0.56, re = R + 0.03 * a_;
        return [
          flagStem(x, xh, 0, ft * 0.2 * a_),
          ft > 0.82 ? bar(x - ft * 0.2 * a_, x + ft * 0.24 * a_, B) : null,
          pen().M(x, xh * 0.56, 0.55).Q(x, To, ra, To, { w: 1, k: 0.5 }).Q(re, To, re, To - (re - ra), { t1: 0.5 })
        ];
      },
      s: () => [ess(Lr + 0.025 * a_, Rr - 0.025 * a_, Bo, To)],
      t: () => {
        const x = cx - 0.075 * a_, rt = 0.21 * a_, re = R + 0.035 * a_;
        return [
          pen().M(x, xh + (asc - xh) * 0.6).L(x, Bo + rt).Q(x, Bo, x + rt, Bo).Q(re, Bo, re, Bo + (re - x - rt), { t1: 0.4 }),
          bar(L - 0.06 * a_, R + 0.02 * a_, T)
        ];
      },
      u: () => { const c = L + (R - L) * 0.48; return [pen().M(L, xh).L(L, Bo + (c - L) * 1.1).Q(L, Bo, c, Bo).Q(R, Bo, R, xh * 0.44, { w: 0.55, k2: 0.5 }), stem(R, 0, xh)]; },
      v: () => [dg(sb * 0.6, xh, -1, cx, 0, 0), dg(adv - sb * 0.6, xh, 1, cx, 0, 0)],
      w: () => {
        const e = sb * 0.3, x1 = adv * 0.295, x2 = adv * 0.705, ya = xh * 0.8, o = { s: 0.86 };
        return [dg(e, xh, -1, x1, 0, 0, o), dg(cx, ya, 0, x1, 0, 0, o), dg(cx, ya, 0, x2, 0, 0, o), dg(adv - e, xh, 1, x2, 0, 0, o)];
      },
      x: () => [dg(sb * 0.75, xh, -1, adv - sb * 0.65, 0, 1), dg(adv - sb * 0.75, xh, 1, sb * 0.65, 0, -1)],
      y: () => {
        const xa = adv - sb * 0.6 - hv, xv = cx - 0.005 * a_, yd = desc * 0.5, sl = (xa - xv) / xh, xd = xv + sl * yd, xz = xv + sl * (Dz - 0);
        const right = pen().M(xa, xh).L(xd, yd).Q(xz, Dz, xz - 0.16 * a_, Dz).cut('h');
        return [right, dg(sb * 0.6, xh, -1, xv + sl * xh * 0.03, xh * 0.03, 0, { c1: 'flat' })];
      },
      z: () => { const e = sb * 0.95; return [bar(e, adv - e, T), dg(adv - e, xh, 1, e, 0, -1), bar(e, adv - e, B)]; },

      A: () => {
        const e = sb * 0.42, l = dg(cx, cap, 0, e, 0, -1), r = dg(cx, cap, 0, adv - e, 0, 1), yb = cap * 0.27;
        return [l, r, bar(xAt(l, yb), xAt(r, yb), yb)];
      },
      B: () => {
        const ym = cap * 0.535, ru = Rc - 0.035 * a_, rl = Rc + 0.012 * a_, yu = (Tc + ym) / 2, yl = (ym + B) / 2;
        const xu = Math.max(Lc + 0.06 * a_, ru - (Tc - ym) / 2), xl = Math.max(Lc + 0.06 * a_, rl - (ym - B) / 2);
        return [
          stem(Lc, 0, cap),
          pen().M(Lc, Tc).L(xu, Tc).Q(ru, Tc, ru, yu).Q(ru, ym, xu, ym).L(Lc, ym),
          pen().M(Lc, ym).L(xl, ym).Q(rl, ym, rl, yl).Q(rl, B, xl, B).L(Lc, B)
        ];
      },
      C: () => [cee(Lcr, Rcr - 0.01 * a_, Bo, Tco)],
      D: () => { const x = Lc + (Rcr - Lc) * 0.33; return [stem(Lc, 0, cap), pen().M(Lc, Tc).L(x, Tc).Q(Rcr, Tc, Rcr, mc).Q(Rcr, B, x, B).L(Lc, B)]; },
      E: () => { const l = Lc + 0.01 * a_, r = adv - sbc * 1.15; return [pen().M(r, Tc).L(l, Tc).L(l, B).L(r, B), bar(l, r - 0.05 * a_, cap * 0.52)]; },
      F: () => { const l = Lc + 0.02 * a_, r = adv - sbc * 1.1; return [pen().M(r, Tc).L(l, Tc).L(l, 0), bar(l, r - 0.06 * a_, cap * 0.47)]; },
      G: () => {
        const r = Rcr - 0.01 * a_, c = (Lcr + r) / 2 + 0.03 * (r - Lcr), yg = cap * 0.44;
        return [pen().MQ(r, mc, r, Tco, c, Tco, { t0: 1 - te }).Q(Lcr, Tco, Lcr, mc).Q(Lcr, Bo, c, Bo).Q(r, Bo, r, Math.min(yg - 10, Bo + (r - c) * 0.95)).L(r, yg).L(cx + 0.02 * a_, yg)];
      },
      H: () => [stem(Lc, 0, cap), stem(Rc, 0, cap), bar(Lc, Rc, cap * 0.52)],
      I: () => { const g = 0.28 * a_; return [stem(cx, 0, cap), bar(cx - g, cx + g, Tc), bar(cx - g, cx + g, B)]; },
      J: () => {
        const r = Rc - 0.02 * a_, l = Lc - 0.02 * a_, c = (l + r) / 2;
        return [pen().M(cx - 0.14 * a_, Tc).L(r, Tc).L(r, Bo + (r - c) * 1.05).Q(r, Bo, c, Bo).Q(l, Bo, l, Bo + (c - l) * 1.05, { t1: te * 0.9 })];
      },
      K: () => {
        const arm = dg(adv - sbc * 0.6, cap, 1, Lc, cap * 0.36, 0, { c1: 'flat' }), a = arm.n[1], b = arm.n[0];
        return [stem(Lc, 0, cap), arm, dg(lerp(a.x, b.x, 0.32), lerp(a.y, b.y, 0.32), 0, adv - sbc * 0.45, 0, 1, { c0: 'flat' })];
      },
      L: () => { const l = Lc + 0.035 * a_; return [pen().M(l, cap).L(l, B).L(adv - sbc * 1.05, B)]; },
      M: () => {
        const s = 0.9, l = sbc * 0.62 + hv * s, r = adv - l, ym = cap * 0.36, o = { s };
        return [stem(l, 0, cap, s), stem(r, 0, cap, s), dg(l - hv * s, cap, -1, cx, ym, 0, o), dg(r + hv * s, cap, 1, cx, ym, 0, o)];
      },
      N: () => { const s = 0.95, l = sbc * 0.95 + hv * s, r = adv - l; return [stem(l, 0, cap, s), stem(r, 0, cap, s), dg(l - hv * s, cap, -1, r + hv * s, 0, 1, { s })]; },
      O: () => [oval(Lcr, Rcr, Bo, Tco)],
      P: () => {
        const ym = cap * 0.43, r = Rc + 0.015 * a_, x = Math.max(Lc + 0.06 * a_, r - (Tc - ym) / 2);
        return [stem(Lc, 0, cap), pen().M(Lc, Tc).L(x, Tc).Q(r, Tc, r, (Tc + ym) / 2).Q(r, ym, x, ym).L(Lc, ym)];
      },
      Q: () => [oval(Lcr, Rcr, Bo, Tco), dg(cx + 0.03 * a_, cap * 0.16, 0, adv - sbc * 1.0, -cap * 0.17, 0, { c0: 'flat', c1: 'flat' })],
      R: () => {
        const ym = cap * 0.47, r = Rc + 0.005 * a_, x = Math.max(Lc + 0.06 * a_, r - (Tc - ym) / 2);
        return [stem(Lc, 0, cap), pen().M(Lc, Tc).L(x, Tc).Q(r, Tc, r, (Tc + ym) / 2).Q(r, ym, x, ym).L(Lc, ym), dg(cx - 0.02 * a_, ym + hh, 0, adv - sbc * 0.5, 0, 1)];
      },
      S: () => [ess(Lcr + 0.02 * a_, Rcr - 0.02 * a_, Bo, Tco)],
      T: () => { const e = sbc * 0.7; return [bar(e, adv - e, Tc), stem(cx, 0, cap)]; },
      U: () => { const y = Bo + (cx - Lc) * 1.05; return [pen().M(Lc, cap).L(Lc, y).Q(Lc, Bo, cx, Bo).Q(Rc, Bo, Rc, y).L(Rc, cap)]; },
      V: () => [dg(sbc * 0.4, cap, -1, cx, 0, 0), dg(adv - sbc * 0.4, cap, 1, cx, 0, 0)],
      W: () => {
        const e = sbc * 0.2, x1 = adv * 0.29, x2 = adv * 0.71, ya = cap * 0.74, o = { s: 0.88 };
        return [dg(e, cap, -1, x1, 0, 0, o), dg(cx, ya, 0, x1, 0, 0, o), dg(cx, ya, 0, x2, 0, 0, o), dg(adv - e, cap, 1, x2, 0, 0, o)];
      },
      X: () => [dg(sbc * 0.6, cap, -1, adv - sbc * 0.45, 0, 1), dg(adv - sbc * 0.6, cap, 1, sbc * 0.45, 0, -1)],
      Y: () => { const ym = cap * 0.42; return [dg(sbc * 0.4, cap, -1, cx, ym, 0, { c1: 'flat' }), dg(adv - sbc * 0.4, cap, 1, cx, ym, 0, { c1: 'flat' }), stem(cx, 0, ym + hh * 2)]; },
      Z: () => { const e = sbc * 0.95; return [bar(e, adv - e, Tc), dg(adv - e, cap, 1, e, 0, -1), bar(e, adv - e, B)]; },

      '0': () => {
        const o = [oval(Lr + 0.012 * a_, Rr - 0.012 * a_, Bo, Tco)];
        if (P.zero === 'dot') o.push(dot(cx, mc, W * 0.52, W * 0.9));
        if (P.zero === 'slash') o.push(dg(cx + 0.105 * a_, mc + cap * 0.19, 0, cx - 0.105 * a_, mc - cap * 0.19, 0, { s: 0.8, c0: 'flat', c1: 'flat' }));
        return o;
      },
      '1': () => {
        const x = cx + 0.035 * a_, g = 0.27 * a_;
        return [stem(x, 0, cap), dg(x + hv, cap, 1, x - 0.27 * a_, cap * 0.75, 0, { c1: 'flat', s: 0.92 }), bar(x - g, x + g, B)];
      },
      '2': () => {
        const l = L, r = R - 0.01 * a_, c = (l + r) / 2, yu = Tco - (r - c) * 1.05, e = sb * 0.95;
        const c2 = [cx + 0.05 * a_, cap * 0.27];
        let xe = e + 60;
        for (let i = 0; i < 3; i++) { const dx = xe - c2[0], dy = hh - c2[1], l2 = Math.hypot(dx, dy); xe = e + 4 + hw(dx / l2, dy / l2) / Math.abs(dy / l2); }
        return [
          pen().MQ(l, yu, l, Tco, c, Tco, { t0: 1 - te * 0.95 }).Q(r, Tco, r, yu).C(r, yu - cap * 0.2, c2[0], c2[1], xe, hh).cut(null, 'h'),
          bar(e, adv - e, B)
        ];
      },
      '3': () => {
        const ym = cap * 0.535, ru = R - 0.03 * a_, rl = R + 0.005 * a_, l = L - 0.005 * a_, c = (l + rl) / 2;
        const yu = (Tco + ym) / 2, yl = (ym + Bo) / 2, xu = ru - (yu - ym) * 0.95, xl = rl - (ym - yl) * 0.95, xs = Math.min(xu, xl) - 0.05 * a_;
        return [
          pen().MQ(l + 0.02 * a_, yu, l + 0.02 * a_, Tco, c, Tco, { t0: 1 - te * 0.9 }).Q(ru, Tco, ru, yu).Q(ru, ym, xu, ym).L(xs, ym),
          pen().M(xs, ym).L(xl, ym).Q(rl, ym, rl, yl).Q(rl, Bo, c, Bo).Q(l, Bo, l, yl, { t1: te * 0.9 })
        ];
      },
      '4': () => {
        const x = cx + 0.14 * a_, yb = cap * 0.27, e = sb * 0.7;
        return [stem(x, 0, cap), bar(e + 10, adv - e, yb), dg(x + hv, cap, 1, e, yb - hh, -1)];
      },
      '5': () => {
        const l = L + 0.02 * a_, r = adv - sb * 1.2, rb = R + 0.012 * a_, lb = L - 0.012 * a_, c = (lb + rb) / 2, yt = cap * 0.605, ym = (yt + Bo) / 2;
        return [
          pen().M(r, Tc).L(l, Tc).L(l, cap * 0.4),
          pen().M(l, cap * 0.44, 0.55).Q(l, yt, c + 0.02 * a_, yt, { w: 1, k: 0.5 }).Q(rb, yt, rb, ym).Q(rb, Bo, c, Bo).Q(lb, Bo, lb, ym, { t1: te * 0.9 })
        ];
      },
      '6': () => {
        const l = Lr + 0.012 * a_, r = Rr - 0.012 * a_, c = (l + r) / 2, yt = cap * 0.61, ym = (yt + Bo) / 2, r6 = r - 0.02 * a_;
        return [pen().MQ(r6, cap * 0.62, r6, Tco, c + 0.02 * a_, Tco, { t0: 1 - te * 0.85 }).Q(l, Tco, l, Math.max(ym + 20, Tco - (c - l) * 1.25)).L(l, ym).Q(l, Bo, c, Bo).Q(r, Bo, r, ym).Q(r, yt, c, yt).Q(l, yt, l, ym - cap * 0.03, { w: 0.55, k2: 0.5 })];
      },
      '7': () => { const e = sb * 0.95; return [bar(e, adv - e, Tc), dg(adv - e, cap, 1, cx - 0.09 * a_, 0, 0)]; },
      '8': () => { const ym = cap * 0.535; return [oval(Lr + 0.04 * a_, Rr - 0.04 * a_, ym, Tco), oval(Lr + 0.008 * a_, Rr - 0.008 * a_, Bo, ym)]; },
      '9': () => G['6']().map((p) => rot(p, cap)),

      '.': () => [dot(cx, pr - 4, pr)],
      ',': () => comma(cx + 0.01 * a_, pr - 4),
      ':': () => [dot(cx, pr - 4, pr), dot(cx, xh - pr, pr)],
      ';': () => comma(cx + 0.01 * a_, pr - 4).concat([dot(cx + 0.01 * a_, xh - pr, pr)]),
      '!': () => [stem(cx, cap * 0.3, cap), dot(cx, pr - 4, pr)],
      '?': () => {
        const l = L + 0.02 * a_, r = R - 0.02 * a_, c = (l + r) / 2, yu = Tco - (r - c) * 1.0;
        return [pen().MQ(l, yu, l, Tco, c, Tco, { t0: 1 - te * 0.95 }).Q(r, Tco, r, yu).C(r, yu - cap * 0.17, cx, cap * 0.5, cx, cap * 0.3), dot(cx, pr - 4, pr)];
      },
      "'": () => [stem(cx, cap * 0.66, cap + 10)],
      '"': () => [stem(cx - 0.1 * a_, cap * 0.66, cap + 10), stem(cx + 0.1 * a_, cap * 0.66, cap + 10)],
      '\u2019': () => comma(cx + 0.01 * a_, cap - pr * 0.75),
      '\u2018': () => comma(cx - 0.01 * a_, cap - pr * 2.3, true),
      '\u201d': () => comma(cx - 0.11 * a_, cap - pr * 0.75).concat(comma(cx + 0.13 * a_, cap - pr * 0.75)),
      '\u201c': () => comma(cx - 0.13 * a_, cap - pr * 2.3, true).concat(comma(cx + 0.11 * a_, cap - pr * 2.3, true)),
      '`': () => [pen().M(cx - 0.08 * a_, asc, 1.2).L(cx + 0.05 * a_, cap * 0.84, 0.8)],
      '-': () => [bar(cx - 0.2 * a_, cx + 0.2 * a_, xh * 0.5)],
      '\u2013': () => [bar(cx - 0.3 * a_, cx + 0.3 * a_, xh * 0.5)],
      '\u2014': () => [bar(0.03 * a_, 0.97 * a_, xh * 0.5)],
      '_': () => [bar(0.02 * a_, 0.98 * a_, desc * 0.55)],
      '(': () => [pen().M(cx + 0.13 * a_, asc + 20).C(cx - 0.17 * a_, cap * 0.78, cx - 0.17 * a_, cap * 0.08, cx + 0.13 * a_, desc * 0.85)],
      ')': () => [pen().M(cx - 0.13 * a_, asc + 20).C(cx + 0.17 * a_, cap * 0.78, cx + 0.17 * a_, cap * 0.08, cx - 0.13 * a_, desc * 0.85)],
      '[': () => { const t = asc + 20 - hh, b = desc * 0.85 + hh; return [pen().M(cx + 0.15 * a_, t).L(cx - 0.08 * a_, t).L(cx - 0.08 * a_, b).L(cx + 0.15 * a_, b)]; },
      ']': () => { const t = asc + 20 - hh, b = desc * 0.85 + hh; return [pen().M(cx - 0.15 * a_, t).L(cx + 0.08 * a_, t).L(cx + 0.08 * a_, b).L(cx - 0.15 * a_, b)]; },
      '{': () => {
        const t = asc + 20 - hh, b = desc * 0.85 + hh, m = (t + b) / 2, q = 0.13 * a_, x = cx + 0.01 * a_;
        return [pen().M(x + 0.16 * a_, t).Q(x, t, x, t - q).L(x, m + q).Q(x, m, x - 0.15 * a_, m), pen().M(x + 0.16 * a_, b).Q(x, b, x, b + q).L(x, m - q).Q(x, m, x - 0.15 * a_, m)];
      },
      '}': () => {
        const t = asc + 20 - hh, b = desc * 0.85 + hh, m = (t + b) / 2, q = 0.13 * a_, x = cx - 0.01 * a_;
        return [pen().M(x - 0.16 * a_, t).Q(x, t, x, t - q).L(x, m + q).Q(x, m, x + 0.15 * a_, m), pen().M(x - 0.16 * a_, b).Q(x, b, x, b + q).L(x, m - q).Q(x, m, x + 0.15 * a_, m)];
      },
      '/': () => [dg(adv - sb * 0.8, asc + 10, 1, sb * 0.8, desc * 0.7, -1)],
      '\\': () => [dg(sb * 0.8, asc + 10, -1, adv - sb * 0.8, desc * 0.7, 1)],
      '|': () => [stem(cx, desc * 0.85, asc + 20)],
      '+': () => { const y = cap * 0.47, h = (R - L) / 2 + 0.03 * a_; return [bar(cx - h, cx + h, y), stem(cx, y - h, y + h)]; },
      '=': () => { const y = cap * 0.47, h = (R - L) / 2 + 0.03 * a_; return [bar(cx - h, cx + h, y + cap * 0.105), bar(cx - h, cx + h, y - cap * 0.105)]; },
      '*': () => {
        const y = cap * 0.6, q = 0.2 * a_, s = 0.82, o = [stem(cx, y - q, y + q, s)];
        for (const a of [30, 150]) { const dx = Math.cos(a * Math.PI / 180) * q, dy = Math.sin(a * Math.PI / 180) * q; o.push(pen(s).M(cx - dx, y - dy).L(cx + dx, y + dy)); }
        return o;
      },
      '#': () => {
        const s = 0.82, d = 0.105 * a_, k = 0.035 * a_, e = sb * 0.55;
        return [pen(s).M(cx - d + k, cap).L(cx - d - k, 0), pen(s).M(cx + d + k, cap).L(cx + d - k, 0), bar(e, adv - e, cap * 0.67, s), bar(e, adv - e, cap * 0.33, s)];
      },
      '<': () => { const y = cap * 0.47, d = cap * 0.24; return [pen().M(R + 0.02 * a_, y + d).L(L - 0.02 * a_, y).L(R + 0.02 * a_, y - d)]; },
      '>': () => { const y = cap * 0.47, d = cap * 0.24; return [pen().M(L - 0.02 * a_, y + d).L(R + 0.02 * a_, y).L(L - 0.02 * a_, y - d)]; },
      '^': () => [pen().M(L, cap * 0.56).L(cx, cap + 6).L(R, cap * 0.56)],
      '~': () => {
        const y = cap * 0.47, d = cap * 0.085, l = L - 0.03 * a_, r = R + 0.03 * a_, q = (r - l) / 4;
        return [pen().M(l, y - d * 0.6).C(l + q * 0.5, y + d * 1.7, l + q * 1.4, y + d * 1.5, cx, y).C(r - q * 1.4, y - d * 1.5, r - q * 0.5, y - d * 1.7, r, y + d * 0.6)];
      },
      '%': () => {
        const s = 0.74, q = 0.135 * a_, hy = cap * 0.17, e = sb * 0.5, xl = e + q + hv * s, xr = adv - xl;
        return [oval(xl - q, xl + q, cap - 2 * hy, cap - hh * s + 4, s), oval(xr - q, xr + q, hh * s - 4, 2 * hy, s), dg(adv - sb * 0.7, cap, 1, sb * 0.7, 0, -1, { s: 0.8 })];
      },
      '$': () => [ess(Lcr + 0.03 * a_, Rcr - 0.03 * a_, Bo + cap * 0.035, Tco - cap * 0.035), stem(cx, cap - hh * 2, cap + 75), stem(cx, -75, hh * 2)],
      '&': () => {
        const lt = L + 0.05 * a_, rt = R - 0.09 * a_, ct = (lt + rt) / 2, yt = cap * 0.74, lb = L - 0.035 * a_, cb = cx - 0.045 * a_, rb = R - 0.005 * a_, yb = cap * 0.27;
        return [pen().M(adv - sb * 0.55 - hv, 0)
          .C(cx + 0.06 * a_, cap * 0.22, lt, cap * 0.5, lt, yt)
          .Q(lt, Tco, ct, Tco).Q(rt, Tco, rt, yt)
          .C(rt, cap * 0.56, lb, cap * 0.52, lb, yb)
          .Q(lb, Bo, cb, Bo)
          .Q(rb, Bo, rb, cap * 0.42, { t1: 0.93 }).cut('h')];
      },
      '@': () => {
        const s = 0.78, l = sb * 0.45 + hv * s, r = adv - l, t = cap + 6 - hh * s, b = desc * 0.5 + hh * s, m = (t + b) / 2, li = cx - 0.075 * a_, it = cap * 0.63, ib = cap * 0.13;
        return [
          pen(s).MQ(r, m, r, b, cx + 0.02 * a_, b, { t0: 0.52 }).Q(l, b, l, m).Q(l, t, cx, t).Q(r, t, r, m).L(r, ib),
          oval(li, r, ib, it, s)
        ];
      }
    };

    // ---------- assemble ----------
    const f1 = (v) => (Math.round(v * 10) / 10).toString();
    const shift = -tanS * xh * 0.5;
    function toPath(items) {
      let d = '';
      for (const it of items) {
        if (!it) continue;
        const poly = it.poly || expand(it);
        for (let i = 0; i < poly.length; i++) {
          const x = poly[i][0] + poly[i][1] * tanS + shift, y = -poly[i][1];
          d += (i ? 'L' : 'M') + f1(x) + ' ' + f1(y);
        }
        d += 'Z';
      }
      return d;
    }
    const glyphs = {};
    let needBox = !only;
    for (const ch of only || Object.keys(G)) { if (G[ch]) glyphs[ch] = toPath(G[ch]()); else needBox = true; }
    // missing glyph: a hollow box
    const mb = 12;
    if (needBox) glyphs.missing = toPath([pen().M(L - mb, B).L(L - mb, Tc).L(R + mb, Tc).L(R + mb, B).L(L - mb, B - 0.4)]);
    return { adv, asc, desc, cap, xh, soft, glyphs };
  }

  root.buildFont = buildFont;
  root.FONT_DEFAULTS = FONT_DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
