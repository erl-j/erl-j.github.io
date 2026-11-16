/* app.js: page logic for the slop detector (no dependencies). Reads SLOP_DATA (slop-data.js),
 * SLOP_EXAMPLES (examples.js) and SlopEngine (engine.js); nothing is sent anywhere.
 *
 * The interface is the one of the Swedish translationese checker, driven by the slop engine.
 * The text box is a scroll container holding a mirror <div> that draws the highlights and an
 * auto-height <textarea> on top of it, in one grid cell: same font, padding and wrapping, and
 * the browser scrolls both together. The whole text is analysed as you type (debounced);
 * between keystrokes the previous highlights are shifted through the edit so they stay on
 * their words. Each count rule with highlighted hits gets one margin note (a chips row on
 * narrow screens), with leader lines from every visible hit: the in-box part in an SVG inside
 * the scroll container, the part outside the box in an overlay.
 *
 * Highlights are the hits of the count rules (engine.marks): each hit adds
 * 1000 * weight / (SD * words) to the logit. A rule's contribution is its "no hits" baseline
 * plus its hits; bias + all contributions = logit. User text only ever reaches the DOM escaped
 * or through textContent.
 *
 * Font view (on by default): textarea and mirror switch to a monospace font with invisible
 * glyphs, and an SVG layer between them draws every character in the procedural font
 * (fontgen.js, styles in fontview.js), placed on the mirror's own line boxes: square and
 * uniform towards AI style, loose and varied towards human style. Display only. */
(function () {
  'use strict';
  const D = globalThis.SLOP_DATA;
  const EXAMPLES = globalThis.SLOP_EXAMPLES || [];
  const MIN_WORDS = 100;        // under this the evidence is shown and the score withheld
  const HIT_MIN = 0.1;          // a rule's hits are highlighted when they add at least this in total
  const DEFAULT_EXAMPLE = 'ai'; // loaded when the page opens
  const NOTE_GAP = 6;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), editor = $('editor');
  const ta = $('text'), bdInner = $('bd-inner');
  const notesL = $('notes-left'), notesR = $('notes-right'), chipsEl = $('chips');
  const svg = $('leaders'), inlay = $('inlay');
  const exBtn = $('ex-btn'), exList = $('ex-list');
  const verdictBtn = $('verdict'), pop = $('pop'), popBody = $('pop-body'), prov = $('prov');

  let eng = null;
  let A = null;           // last analysis (see build())
  let shown = '';         // text the backdrop currently mirrors
  let spans = [];         // highlighted hits of the last analysis, shifted through edits since
  let runs = null;        // backdrop text nodes: { starts: number[], nodes: Text[] }
  let rects = null;       // per span: line boxes in backdrop-content coordinates, or null = recompute
  let rectsW = -1;
  let active = null;      // rule whose lines are emphasised (hover, or the open popup)
  let hoverRule = null;
  let popRule = null;     // rule shown in the popup, '' for the verdict popup, null = closed
  let popAnchor = null;
  let composing = false;
  let showWeak = false;   // also highlight rules whose hits add less than HIT_MIN
  let benchMsg = '';

  // font view state (see drawFont)
  const FV = globalThis.SlopFont && globalThis.buildFont ? globalThis.SlopFont : null;
  const appEl = $('app'), fontBtn = $('font-btn'), glyphSvg = $('glyphs');
  const FONT_KEY = 'slop-detector-font-view';
  let fontOn = false;
  let fontDirty = true;   // text, hits, width or font changed: redraw the glyph layer
  let fvWin = null;       // { top, bot }: content rows the glyph layer covers
  let fvBest = null;      // per character of `shown`: index into fvSpans of its strongest hit, -1 = none
  let fvSpans = [];
  let fvWords = null;     // [start, end, start, end, ...] of the non-space runs of `shown`
  let fvProbe = null, fvNext = 0;
  glyphSvg.innerHTML = '<defs></defs><g fill="currentColor" stroke="currentColor" stroke-linejoin="round"></g>';
  const fvDefs = glyphSvg.firstChild, fvG = glyphSvg.lastChild;

  const sign = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
  const dirOf = (x) => (x > 0 ? 't' : x < 0 ? 'o' : 'u');   // t = towards AI style, o = towards human style
  const DIRNAME = { t: 'AI style', o: 'human style' };
  // continuous intensity 0..1 of a hit's weight or a rule's contribution (colour scale)
  const kSpan = (x) => Math.min(1, Math.abs(x) / 1.0) ** 0.75;
  const kRule = (x) => Math.min(1, Math.abs(x) / 1.5) ** 0.75;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const narrow = () => getComputedStyle(chipsEl).display !== 'none';
  const sig = (x) => {
    if (!Number.isFinite(x)) return 'undefined';
    if (x === 0) return '0';
    const a = Math.abs(x);
    return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : a >= 1 ? x.toFixed(2) : x.toFixed(3);
  };
  const fam = (f) => (f || '').replace(/_/g, ' ');
  const OBSERVED = { 'AI>H': 'AI texts have more', 'AI<H': 'human texts have more', mixed: 'mixed' };
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }

  // --- analysis ------------------------------------------------------------------------
  function init() {
    fillExamples();
    const bands = D.bands.bands;
    for (const [i, t] of ['v-tick1', 'v-tick2'].entries()) {
      if (bands[i + 1]) $(t).style.left = (100 * bands[i + 1][0]).toFixed(1) + '%';
    }
    try {
      eng = new globalThis.SlopEngine.Engine(D);
      // compile every regex once so the timing readout shows steady-state speed
      for (let k = 0; k < 3; k++) { eng.explain('Warm up, café.'); for (const ex of EXAMPLES) eng.marks(eng.explain(ex.text)); }
    } catch (e) {
      eng = null;
      setFont(false); // the glyph layer is drawn from the analysis; without it, show plain text
      const old = e instanceof SyntaxError && /flag|regular expression|group|lookbehind/i.test(String(e));
      setVerdictText(old
        ? 'Your browser is too old for this page (it needs Chrome/Edge 112+, Firefox 116+ or Safari 17+).'
        : 'Could not start the engine: ' + e.message);
      console.error(e);
      return;
    }
    const i = EXAMPLES.findIndex((e) => e.key === DEFAULT_EXAMPLE);
    if (!ta.value.trim() && EXAMPLES.length) exChoose(Math.max(0, i));
    else analyse();
    if (location.hash === '#speed-test') { runBench(); openVerdict(verdictBtn); }
  }

  let timer = 0;
  function scheduleAnalysis() {
    clearTimeout(timer);
    timer = setTimeout(analyse, ta.value.length > 20000 ? 320 : 180);
  }

  // Offsets: the engine reports spans in its normalised text (NFC, zero-width characters
  // removed, CRLF -> LF, exotic spaces -> ' '); the highlights must sit on the textarea's
  // own characters. Map each normalised character back to the raw character run it came from
  // (a base character with its combining marks): a span [a, b) of the engine's text is
  // [s[a], e[b - 1]) of the raw text. null = identical texts, false = no map.
  const ZERO = new Set(D.doc.zero), SPACES = new Set(D.doc.spaces);
  function offsetMap(raw, norm) {
    if (raw === norm) return null;
    const s = [], e = [];
    let out = '';
    for (const m of raw.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
      for (let c of m[0].normalize('NFC')) {
        if (ZERO.has(c)) continue;
        if (c === '\r') { if (raw[m.index + 1] === '\n') continue; c = '\n'; } else if (SPACES.has(c)) c = ' ';
        for (let k = 0; k < c.length; k++) { s.push(m.index); e.push(m.index + m[0].length); }
        out += c;
      }
    }
    return out === norm ? { s, e } : false;
  }

  function build(text) {
    const t0 = performance.now();
    const res = eng.explain(text), mk = eng.marks(res);
    const ms = performance.now() - t0;
    const rows = new Map(res.rows.map((r) => [r.id, r]));
    const hitRules = new Set();
    for (const m of mk.marks) for (const q of m.parts) hitRules.add(q.id);
    const map = offsetMap(text, res.doc.text);
    if (map === false) console.warn('slop detector: no offset map from the engine text to the input; highlights off');
    const all = [];
    if (map !== false) {
      for (const id of hitRules) {
        const r = rows.get(id);
        const per = 1000 * r.weight / (r.sd * res.doc.n);   // what one hit adds to the logit (engine.marks)
        const strong = Math.abs(per * r.spans.length) >= HIT_MIN;
        for (const [a, b] of r.spans) {
          if (b <= a) continue;
          const start = map ? map.s[a] : a, end = map ? map.e[b - 1] : b;
          all.push({ start, end, rule: id, share: per, d: per >= 0 ? 't' : 'o', text: text.slice(start, end), strong });
        }
      }
    }
    all.sort((x, y) => x.start - y.start || x.end - y.end);
    const n = res.nWords;
    return { res, mk, ms, rows, hitRules, all, nWords: n, nSent: res.doc.sentences.length,
      scored: n >= MIN_WORDS, short: n > 0 && n < MIN_WORDS };
  }
  const visibleSpans = () => (A ? (showWeak ? A.all : A.all.filter((s) => s.strong)) : []);

  function analyse() {
    clearTimeout(timer);
    if (!eng || composing) return;
    const text = ta.value;
    try {
      A = build(text);
    } catch (e) {
      setVerdictText('Analysis failed: ' + e.message);
      console.error(e);
      return;
    }
    spans = visibleSpans();
    renderBackdrop(text);
    renderVerdict();
    if (popRule === '') openVerdict(popAnchor, true);
    else if (popRule) {
      if (A.rows.has(popRule)) openRule(popRule, popAnchor, true);
      else closePop();
    }
    schedule();
  }

  // Between keystroke and analysis: move the old spans with the edit (common prefix/suffix),
  // drop the ones the edit touched, so the highlights stay on their words while typing.
  function shiftSpans(oldT, newT) {
    const n = Math.min(oldT.length, newT.length);
    let p = 0;
    while (p < n && oldT.charCodeAt(p) === newT.charCodeAt(p)) p++;
    let s = 0;
    while (s < n - p && oldT.charCodeAt(oldT.length - 1 - s) === newT.charCodeAt(newT.length - 1 - s)) s++;
    const oldEnd = oldT.length - s, d = newT.length - oldT.length;
    const out = [];
    for (const sp of spans) {
      if (sp.end <= p) out.push(sp);
      else if (sp.start >= oldEnd) out.push({ ...sp, start: sp.start + d, end: sp.end + d });
    }
    spans = out;
  }

  // --- backdrop: per character the strongest covering hit is drawn ------------------------
  function renderBackdrop(text) {
    shown = text;
    rects = null;
    const best = new Int32Array(text.length).fill(-1);
    spans.forEach((s, i) => {
      const w = Math.abs(s.share);
      for (let k = s.start; k < s.end && k < text.length; k++) {
        const b = best[k];
        if (b < 0 || w > Math.abs(spans[b].share)) best[k] = i;
      }
    });
    const html = [], starts = [];
    let k = 0;
    while (k < text.length) {
      const b = best[k];
      let j = k + 1;
      while (j < text.length && best[j] === b) j++;
      starts.push(k);
      const chunk = esc(text.slice(k, j));
      if (b < 0) html.push(chunk);
      else {
        const s = spans[b];
        html.push(`<mark class="${s.d} dir-${s.d}" style="--k:${kSpan(s.share).toFixed(2)}">${chunk}</mark>`);
      }
      k = j;
    }
    bdInner.innerHTML = html.join('');
    const nodes = [];
    for (const c of bdInner.childNodes) nodes.push(c.nodeType === 3 ? c : c.firstChild);
    runs = { starts, nodes };
    fvBest = best;
    fvSpans = spans;
    fvWords = null;
    sideCache.clear();
    invalidate();
  }

  function runAt(off) { // index of the backdrop text node holding a character offset
    const st = runs.starts;
    let lo = 0, hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function locate(off) { // backdrop text node and offset in it for a character offset
    const i = runAt(off);
    return [runs.nodes[i], off - runs.starts[i]];
  }

  function ensureRects() {
    if (rects && rectsW === bdInner.clientWidth) return;
    rectsW = bdInner.clientWidth;
    rects = new Array(spans.length).fill(null);
    if (!runs || !runs.nodes.length) return;
    const base = bdInner.getBoundingClientRect();
    const range = document.createRange();
    const len = shown.length;
    spans.forEach((s, i) => {
      if (s.start >= len || s.end <= s.start) return;
      const [na, oa] = locate(s.start);
      const [nb, ob] = locate(Math.min(s.end, len) - 1);
      try {
        range.setStart(na, oa);
        range.setEnd(nb, ob + 1);
      } catch { return; }
      const lines = [];
      for (const r of range.getClientRects()) {
        const y = r.top - base.top, x = r.left - base.left;
        if (r.width < 1 || x + r.width < 2) continue;
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - y) < 3) {
          const right = Math.max(last.x + last.w, x + r.width);
          last.x = Math.min(last.x, x);
          last.w = right - last.x;
        } else lines.push({ x, y, w: r.width, h: r.height });
      }
      rects[i] = lines;
    });
  }

  // --- verdict strip -----------------------------------------------------------------
  function setVerdictText(msg) {
    verdictBtn.className = 'verdict no-score';
    verdictBtn.parentNode.className = 'vbar';
    $('v-label').textContent = msg;
    $('v-prob').textContent = '';
    $('v-words').textContent = '';
  }

  function verdictName(a) {
    if (!a || a.nWords === 0) return ['u', 'Type or paste English text', 'Type or paste text'];
    if (!a.scored) return ['u', 'Too short for a score', 'Too short'];
    const bands = D.bands.bands;
    let i = 0;
    bands.forEach(([lo], j) => { if (a.res.p >= lo) i = j; });
    const name = bands[i][1];
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const d = i === 0 ? 'o' : i === bands.length - 1 ? 't' : 'u';
    return [d, cap(name), cap(name.replace(/( of)? slop$/, ''))];
  }

  function renderVerdict() {
    const [d, long, short] = verdictName(A);
    const has = A.scored;
    verdictBtn.className = 'verdict' + (d === 'u' ? '' : ' is-' + d) + (has ? '' : ' no-score');
    verdictBtn.parentNode.className = 'vbar' + (d === 'u' ? '' : ' is-' + d);
    verdictBtn.style.setProperty('--k', Math.min(1, Math.abs(A.res.logit) / 4).toFixed(3));
    $('v-label').innerHTML = `<span class="lw">${long}</span><span class="ln">${short}</span>`;
    const p = has ? A.res.p : 0.5;
    $('v-mark').style.left = (p * 100).toFixed(1) + '%';
    $('v-prob').innerHTML = has ? `<span class="lw">P(AI-style) </span><span class="ln">P </span>${p.toFixed(2)}` : '';
    const w = $('v-words');
    w.textContent = A.nWords ? `${A.nWords} word${A.nWords === 1 ? '' : 's'}` : '';
    w.classList.toggle('short', A.short);
    verdictBtn.setAttribute('aria-label', has
      ? `Verdict: ${long}, probability of AI style ${p.toFixed(2)}, ${A.nWords} words. Show details.`
      : A.short ? `${long}: ${A.nWords} words, a score needs ${MIN_WORDS}. Show details.` : long);
  }

  // --- notes, chips and leader lines ------------------------------------------------------
  // Three speeds of work, so scrolling stays cheap:
  //  measure()  text, width, font or viewport changed: span geometry (content coordinates),
  //             stage/column geometry, the in-box line layer. The only DOM reads.
  //  place()    the set of rules in view changed (or scrolling stopped): fill and stack
  //             the notes or chips. Note heights are read only for notes whose text changed.
  //  frame()    every scroll frame: pure arithmetic on cached numbers, then one write of
  //             the outer line layer. The highlights and in-box lines scroll natively.
  let geo = null;          // cached geometry, null = measure() before the next frame
  let inlayDirty = true;
  let placedKey = '';      // which rules the notes were stacked for
  let anchors = new Map(); // rule -> { nx, nyc, side } note anchor (wide mode)
  let chipPos = [];        // [{ rule, cx, top }] chip centres in chips-content coordinates
  let raf = 0, idleT = 0;

  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; frame(false); });
  }
  function invalidate() { // text, width, font or viewport changed
    geo = null;
    inlayDirty = true;
    fontDirty = true;
    placedKey = '';
    schedule();
  }

  const noteEls = new Map(); // key "R:rule" / "L:rule" / "C:rule" -> element

  function noteEl(key, rule, kind) {
    let e = noteEls.get(key);
    if (!e) {
      e = el('button', { type: 'button', class: kind, 'data-rule': rule });
      e.innerHTML = '<span class="n-title"></span><span class="n-val"></span>' + (kind === 'mnote' ? '<span class="n-n"></span><span class="n-o"></span>' : '');
      const meta = A && A.rows.get(rule);
      if (kind === 'mnote' && meta) {
        const refs = refsOf(meta.meta);
        e.lastChild.textContent = originTag(meta.meta);
        if (refs.length) e.lastChild.classList.add(refs[0].kind);
      }
      noteEls.set(key, e);
    }
    return e;
  }

  function fillNote(e, g) { // returns true if the text changed (height must be re-read)
    const r = A && A.rows.get(g.rule);
    const c = r ? r.contribution : g.share;
    const d = noteDir(g);
    const cls = (e.classList.contains('chip') ? 'chip ' : 'mnote ') + d + (g.rule === active ? ' on' : '');
    if (e.className !== cls) e.className = cls;
    e.style.setProperty('--k', kRule(c).toFixed(3));
    const title = r ? r.meta.name : g.rule;
    const kids = e.children;
    let changed = false;
    if (kids[0].textContent !== title) { kids[0].textContent = title; changed = true; }
    const v = sign(c);
    if (kids[1].textContent !== v) { kids[1].textContent = v; changed = true; }
    if (kids[2]) {
      const words = [...new Set(g.all.map((s) => s.text.replace(/\s+/g, ' ').trim().toLowerCase()))];
      const short = words.map((w) => (w.length > 28 ? w.slice(0, 26) + '…' : w));
      const n = g.all.length;
      const txt = (n > 1 ? `×${n} · ` : '') + short.join(' · ');
      if (kids[2].textContent !== txt) { kids[2].textContent = txt; changed = true; }
    }
    e.setAttribute('aria-label', `${title}: ${v} towards ${c > 0 ? 'AI style' : 'human style'}. Show rule.`);
    return changed;
  }

  function measure() {
    ensureRects();
    const st = stage.getBoundingClientRect(), er = editor.getBoundingClientRect();
    const nar = narrow();
    const both = !nar && getComputedStyle(notesL).display !== 'none';
    const col = (c, side) => {
      const r = c.getBoundingClientRect();
      return { el: c, sc: c.firstElementChild, inner: c.firstElementChild.firstElementChild, scroll: c.firstElementChild.scrollTop,
        top0: r.top - st.top, H: r.height, cx: side === 'R' ? r.left - st.left : r.right - st.left,
        items: new Map(), contentH: 0 };
    };
    geo = {
      stL: st.left, stT: st.top, ex: er.left - st.left, ey: er.top - st.top,
      cw: bdInner.clientWidth, H: editor.clientHeight, narrow: nar, both,
      L: both ? col(notesL, 'L') : null, R: nar ? null : col(notesR, 'R'),
      chips: nar ? chipsEl.getBoundingClientRect() : null,
      fv: fontOn ? fvMetrics() : null,
    };
    // span groups by rule, in content coordinates (independent of scroll)
    const groups = new Map();
    spans.forEach((s, i) => {
      const rs = rects[i];
      if (!rs || !rs.length) return;
      let g = groups.get(s.rule);
      if (!g) groups.set(s.rule, (g = { rule: s.rule, items: [], all: [], share: 0 }));
      g.all.push(s);
      g.share += s.share;
      g.items.push({ s, rects: rs, d: s.d, k: kSpan(s.share) });
    });
    geo.groups = [...groups.values()];
  }

  // rules with a span line in view, sorted by their first visible span; stage coordinates
  function visibleGroups(st) {
    const out = [];
    const lo = st, hi = st + geo.H;
    for (const g of geo.groups) {
      let vis = null;
      for (const it of g.items) {
        for (const r of it.rects) {
          const mid = r.y + r.h / 2;
          if (mid < lo || mid > hi) continue;
          (vis || (vis = [])).push({ it, r });
        }
      }
      if (vis) out.push({ ...g, vis, y: geo.ey + vis[0].r.y - st, x: geo.ex + vis[0].r.x });
    }
    return out.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  // The in-box part of every line (span end to the box edge, dotted) and the active rule's
  // outlines live in an SVG inside the scroll container: rebuilt on text, width or active
  // changes only, never on scroll.
  function drawInlay() {
    inlayDirty = false;
    const out = [];
    if (!geo.narrow) {
      for (const g of geo.groups) {
        const on = g.rule === active ? ' on' : '';
        const left = geo.both && sideOf(g) === 'L';
        const nd = noteDir(g);
        for (const it of g.items) {
          const r = left ? it.rects[0] : it.rects[it.rects.length - 1];
          const x0 = left ? r.x : r.x + r.w, y0 = r.y + r.h + 1.5;
          const xe = left ? 0 : geo.cw;
          out.push(`<path class="seg ${nd}${on}" style="--k:${it.k.toFixed(2)}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}H${xe.toFixed(1)}"/>` +
            `<circle class="dot ${nd}${on}" style="--k:${it.k.toFixed(2)}" cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="2"/>`);
        }
      }
    }
    const g = active && geo.groups.find((x) => x.rule === active);
    if (g) for (const it of g.items) for (const r of it.rects) {
      out.push(`<rect class="hl ${it.d}" x="${(r.x - 1).toFixed(1)}" y="${(r.y - 1).toFixed(1)}" width="${(r.w + 2).toFixed(1)}" height="${(r.h + 2).toFixed(1)}"/>`);
    }
    inlay.innerHTML = out.join('');
    inlay.classList.toggle('has-active', !!active);
  }

  // --- font view: every character drawn in the procedural font -----------------------------
  // Positions come from the mirror: one Range per word piece (the part of a word inside one
  // backdrop text node) gives its line boxes; in the monospace font each box holds
  // width / cell characters, spread evenly. Words with anything else (accents outside Latin
  // Extended, emoji, zero-width characters, a cell count that does not add up) are placed one
  // grapheme at a time from their own boxes. Baseline = box top + the font's ascent, read
  // from a hidden probe. Only the rows near the scroll window are drawn.
  const FAST = /^[\x21-\x7e\u00a1-\u024f\u2018-\u201d\u2013\u2014]+$/; // one cell each in a monospace font
  const CLUSTER = /\p{RI}\p{RI}|\P{M}\p{M}*\p{Emoji_Modifier}?(?:\u200d\P{M}\p{M}*\p{Emoji_Modifier}?)*|\p{M}+/gu;
  const SVGNS = 'http://www.w3.org/2000/svg';

  function fvMetrics() { // cell width and baseline offset (from the top of a text box) of the editor font
    if (!fvProbe) {
      fvProbe = el('div', { class: 'bd-inner fv-probe', 'aria-hidden': 'true' }, '0000000000', el('span', { class: 'fv-base' }));
      $('ed-grid').append(fvProbe);
    }
    const range = document.createRange();
    range.selectNodeContents(fvProbe.firstChild);
    const r = range.getBoundingClientRect(), b = fvProbe.lastChild.getBoundingClientRect();
    return { cw: r.width / 10, asc: b.top - r.top };
  }

  function drawFont(st) {
    fontDirty = false;
    const text = shown;
    if (!runs || !runs.nodes.length || !geo.fv || !(geo.fv.cw > 0)) {
      fvG.replaceChildren();
      fvWin = { top: -Infinity, bot: Infinity };
      return;
    }
    if (FV.cache.size > 6000) { FV.cache.clear(); fvDefs.replaceChildren(); } // bound memory on long sessions
    const { cw, asc } = geo.fv, s = cw / FV.ADV, sc = ` scale(${s.toFixed(5)})`;
    const margin = Math.max(240, geo.H * 0.6), top = st - margin, bot = st + geo.H + margin;
    if (!fvWords) {
      fvWords = [];
      for (const m of text.matchAll(/\S+/g)) fvWords.push(m.index, m.index + m[0].length);
    }
    const nw = fvWords.length / 2;
    const base = bdInner.getBoundingClientRect(), bx = base.left, by = base.top;
    const range = document.createRange();
    const boxes = (ri, a, b) => {
      const o = runs.starts[ri];
      range.setStart(runs.nodes[ri], a - o);
      range.setEnd(runs.nodes[ri], b - o);
      return range.getClientRects();
    };
    // first word whose first character reaches into the window (words run down the page in order)
    let lo = 0, hi = nw;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, a = fvWords[2 * mid];
      const r = boxes(runAt(a), a, a + 1)[0];
      if (r && r.bottom - by >= top) hi = mid; else lo = mid + 1;
    }
    // document style: P(AI-style), or the midpoint when there is no score
    const tDoc = A && A.scored ? A.res.p : 0.5, lvDoc = FV.levelOf(tDoc);
    const out = [], fresh = [];
    let vars = new Uint8Array(64), wa = 0, done = true;
    const idOf = (g) => {
      if (!g.id) {
        g.id = 'fg' + (fvNext++).toString(36);
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('id', g.id);
        p.setAttribute('d', g.d);
        p.setAttribute('stroke-width', g.soft.toFixed(1));
        fresh.push(p);
      }
      return g.id;
    };
    const put = (i, ch, x, w, y) => {
      const bi = fvBest && i < fvBest.length ? fvBest[i] : -1;
      let lv = lvDoc, hv = 0;
      if (bi >= 0 && fvSpans[bi]) { // inside a hit: pushed towards the hit's own pole by its strength, and heavier
        const sp = fvSpans[bi], k = kSpan(sp.share);
        lv = FV.levelOf(tDoc + ((sp.d === 't' ? 1 : 0) - tDoc) * k);
        hv = Math.round(k * (FV.HEAVY - 1));
      }
      const g = ch.length === 1 ? FV.glyph(ch, lv, vars[i - wa], hv) : null;
      if (g) out.push(`<use href="#${idOf(g)}" transform="translate(${(x + (w - g.adv * s) / 2).toFixed(2)} ${(y - g.dy * s).toFixed(2)})${sc}"/>`);
      else out.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}">${esc(ch)}</text>`);
    };
    for (let w = lo; w < nw; w++) {
      const a = fvWords[2 * w], b = fvWords[2 * w + 1];
      // variant per character: hash of the previous word and this word up to the character, so
      // typing at the end of a word leaves its earlier letters alone
      let h = w ? FV.hashStr(text.slice(fvWords[2 * w - 2], fvWords[2 * w - 1]) + '\u0001') : FV.HASH0;
      if (vars.length < b - a) vars = new Uint8Array(b - a);
      for (let i = a; i < b; i++) { h = FV.step(h, text.charCodeAt(i)); vars[i - a] = FV.variantOf(h); }
      wa = a;
      let past = false;
      for (let p = a; p < b;) {
        const ri = runAt(p), q = Math.min(b, ri + 1 < runs.starts.length ? runs.starts[ri + 1] : text.length);
        const rs = boxes(ri, p, q);
        if (p === a && rs.length && rs[0].top - by > bot) { past = true; break; }
        const str = text.slice(p, q), cells = [];
        let n = 0;
        for (const r of rs) if (r.width > 0.5) { const c = Math.round(r.width / cw); cells.push([r, c]); n += c; }
        if (FAST.test(str) && n === str.length) {
          let i = p;
          for (const [r, c] of cells) {
            const cwr = r.width / c;
            for (let j = 0; j < c; j++, i++) put(i, text[i], r.left - bx + j * cwr, cwr, r.top - by + asc);
          }
        } else {
          for (const m of str.matchAll(CLUSTER)) {
            const i = p + m.index;
            const r = [...boxes(ri, i, i + m[0].length)].find((x) => x.width > 0.5);
            if (r) put(i, m[0], r.left - bx, r.width, r.top - by + asc);
          }
        }
        p = q;
      }
      if (past) { done = false; break; }
    }
    if (fresh.length) fvDefs.append(...fresh);
    fvG.innerHTML = out.join('');
    fvWin = { top: lo === 0 ? -Infinity : top, bot: done ? Infinity : bot };
  }

  function setFont(on, save = false) {
    fontOn = !!(on && FV);
    appEl.classList.toggle('fv', fontOn);
    fontBtn.setAttribute('aria-pressed', String(fontOn));
    if (!fontOn) { fvG.replaceChildren(); fvWin = null; }
    if (save) try { localStorage.setItem(FONT_KEY, fontOn ? '1' : '0'); } catch { /* storage blocked */ }
    rects = null; // the font changed: hit boxes, notes and lines are measured again
    invalidate();
  }
  if (FV) {
    let saved = null;
    try { saved = localStorage.getItem(FONT_KEY); } catch { /* storage blocked */ }
    setFont(saved !== '0');
    // legend: "human style" set at the human pole, "AI style" at the AI pole
    for (const e of document.querySelectorAll('.legend [data-spec]')) {
      const lv = e.dataset.spec === 'hand' ? 0 : FV.LEVELS - 1;
      try { e.insertAdjacentHTML('beforeend', FV.specimen(e.textContent.trim(), lv, 13)); } catch (err) { console.error(err); }
    }
  } else fontBtn.hidden = true;
  fontBtn.addEventListener('click', () => setFont(!fontOn, true));

  // left or right margin (both margins only on wide screens): by direction, as on the meter
  // (human style left, AI style right); same direction as the note's colour in fillNote
  const sideCache = new Map();
  // direction of a rule's note, its side and its leader lines: the sign of the rule's total
  // contribution (baseline + hits), which can differ from the direction of its single hits
  function noteDir(g) {
    const r = A && A.rows.get(g.rule);
    const c = r ? r.contribution : g.share;
    return dirOf(c) === 'u' ? (g.share > 0 ? 't' : 'o') : dirOf(c);
  }
  function sideOf(g) {
    let s = sideCache.get(g.rule);
    if (!s) {
      s = noteDir(g) === 'o' ? 'L' : 'R';
      sideCache.set(g.rule, s);
    }
    return s;
  }

  function placeColumn(col, side, groups) {
    const cg = geo[side];
    const inner = cg.inner;
    const want = new Set();
    const items = groups.map((g) => {
      const key = side + ':' + g.rule;
      want.add(key);
      const e = noteEl(key, g.rule, 'mnote');
      const fresh = e.parentNode !== inner;
      const changed = fillNote(e, g);
      if (fresh) inner.append(e);
      return { g, e, key, measure: fresh || changed || e._h === undefined };
    });
    for (const e of [...inner.querySelectorAll('.mnote')]) {
      if (!want.has(side + ':' + e.dataset.rule)) { e.remove(); noteEls.delete(side + ':' + e.dataset.rule); }
    }
    for (const it of items) {
      if (it.measure) it.e._h = it.e.offsetHeight;
      it.h = it.e._h;
    }
    const total = items.reduce((s, it) => s + it.h + NOTE_GAP, -NOTE_GAP);
    if (total <= cg.H) {
      // everything fits: each note as close to its first span as the stack allows
      let prev = -Infinity;
      for (const it of items) {
        it.top = Math.max(it.g.y - cg.top0 - 7, prev + NOTE_GAP, 0);
        prev = it.top + it.h;
      }
      let limit = cg.H;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        it.top = Math.min(it.top, limit - it.h);
        limit = it.top - NOTE_GAP;
      }
      cg.contentH = cg.H;
    } else {
      // too many: a plain stack in span order, and the column scrolls
      let y = 0;
      for (const it of items) { it.top = y; y += it.h + NOTE_GAP; }
      cg.contentH = y - NOTE_GAP;
    }
    inner.style.height = cg.contentH + 'px';
    cg.items = new Map();
    for (const it of items) {
      it.e.style.transform = `translateY(${it.top.toFixed(1)}px)`;
      cg.items.set(it.g.rule, { top: it.top, h: it.h });
      anchors.set(it.g.rule, { nx: cg.cx, nyc: it.top + Math.min(it.h / 2, 13), side });
    }
  }

  function placeChips(groups) {
    const want = new Set();
    const els = groups.map((g) => {
      const key = 'C:' + g.rule;
      want.add(key);
      const e = noteEl(key, g.rule, 'chip');
      fillNote(e, g);
      return e;
    });
    const cur = [...chipsEl.children];
    if (cur.length !== els.length || cur.some((e, k) => e !== els[k])) chipsEl.replaceChildren(...els);
    for (const k of [...noteEls.keys()]) if (k.startsWith('C:') && !want.has(k)) noteEls.delete(k);
    chipPos = els.map((e, k) => ({ rule: groups[k].rule, cx: e.offsetLeft + e.offsetWidth / 2, top: e.offsetTop }));
  }

  function place(groups) {
    anchors = new Map();
    if (geo.narrow) {
      for (const col of [notesL, notesR]) col.querySelector('.notes-inner').replaceChildren();
      for (const k of [...noteEls.keys()]) if (!k.startsWith('C:')) noteEls.delete(k);
      placeChips(groups);
    } else {
      chipsEl.replaceChildren();
      for (const k of [...noteEls.keys()]) if (k.startsWith('C:')) noteEls.delete(k);
      const left = geo.both ? groups.filter((g) => sideOf(g) === 'L') : [];
      const right = groups.filter((g) => !left.includes(g));
      if (geo.both) placeColumn(notesL, 'L', left); else notesL.querySelector('.notes-inner').replaceChildren();
      placeColumn(notesR, 'R', right);
    }
  }

  function frame(force) {
    cancelAnimationFrame(raf);
    raf = 0;
    const st = editor.scrollTop;                 // reads first: layout is clean here
    const chipScroll = geo && geo.narrow ? chipsEl.scrollLeft : 0;
    if (geo) for (const side of ['L', 'R']) if (geo[side]) geo[side].scroll = geo[side].sc.scrollTop;
    if (!geo) measure();
    if (fontOn && (fontDirty || !fvWin || st < fvWin.top || st + geo.H > fvWin.bot)) drawFont(st);
    if (inlayDirty) drawInlay();
    const groups = visibleGroups(st);
    const key = groups.map((g) => g.rule).join('|');
    if (force || key !== placedKey) {
      placedKey = key;
      place(groups);
    }
    // outer line layer: box edge -> note, or span -> chip on narrow screens
    const out = [];
    const act = active;
    if (geo.narrow) {
      const cl = geo.chips.left - geo.stL, ct = geo.chips.top - geo.stT;
      const byRule = new Map(chipPos.map((c) => [c.rule, c]));
      for (const g of groups) {
        const c = byRule.get(g.rule);
        if (!c) continue;
        const cx = c.cx - chipScroll;
        if (cx < 4 || cx > geo.chips.width - 4) continue;
        const nx = cl + cx, ny = ct + c.top;
        const on = g.rule === act ? ' on' : '';
        // one line per chip (from the rule's first visible span), all of them when active
        for (const v of g.rule === act ? g.vis : g.vis.slice(0, 1)) {
          const x0 = geo.ex + v.r.x + Math.min(v.r.w / 2, 12), y0 = geo.ey + v.r.y + v.r.h + 1.5 - st;
          const k2 = Math.max(12, (ny - y0) / 2);
          out.push(`<path class="${noteDir(g)}${on}" style="--k:${v.it.k.toFixed(2)}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}C${x0.toFixed(1)} ${(y0 + k2).toFixed(1)} ${nx.toFixed(1)} ${(ny - k2).toFixed(1)} ${nx.toFixed(1)} ${ny.toFixed(1)}"/>` +
            `<circle class="dot ${v.it.d}${on}" style="--k:${v.it.k.toFixed(2)}" cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="2"/>`);
        }
      }
    } else {
      for (const side of ['L', 'R']) { // edge fades of the note columns
        const cg = geo[side];
        if (!cg) continue;
        cg.el.classList.toggle('fade-top', cg.scroll > 1);
        cg.el.classList.toggle('fade-bottom', cg.scroll < cg.contentH - cg.H - 1);
      }
      for (const g of groups) {
        const a = anchors.get(g.rule);
        if (!a) continue;
        const cg = geo[a.side];
        let ny = cg.top0 + a.nyc - cg.scroll;
        // a note scrolled out of its column: the line ends, faded, at the column's edge
        const off = ny < cg.top0 + 4 || ny > cg.top0 + cg.H - 4;
        if (off) ny = Math.max(cg.top0 + 4, Math.min(ny, cg.top0 + cg.H - 4));
        a.ny = ny;
        const on = (g.rule === act ? ' on' : '') + (off ? ' off' : '');
        const xe = a.side === 'R' ? geo.ex + geo.cw : geo.ex;
        const dx = (a.nx - xe) / 2;
        for (const v of g.vis) {
          if (v.r !== (a.side === 'R' ? v.it.rects[v.it.rects.length - 1] : v.it.rects[0])) continue;
          const y0 = geo.ey + v.r.y + v.r.h + 1.5 - st;
          out.push(`<path class="${noteDir(g)}${on}" style="--k:${v.it.k.toFixed(2)}" d="M${xe.toFixed(1)} ${y0.toFixed(1)}C${(xe + dx).toFixed(1)} ${y0.toFixed(1)} ${(a.nx - dx).toFixed(1)} ${a.ny.toFixed(1)} ${a.nx.toFixed(1)} ${a.ny.toFixed(1)}"/>`);
        }
      }
    }
    svg.innerHTML = out.join('');
    svg.classList.toggle('has-active', !!act);
    for (const c of [notesL, notesR]) c.classList.toggle('has-active', !!act);
  }

  // scrolling: lines every frame; notes restack only when the set of rules in view changes,
  // and once more (to realign) when scrolling has stopped
  function onScroll() {
    schedule();
    clearTimeout(idleT);
    idleT = setTimeout(() => frame(true), 160);
  }

  // bring a rule's note (or chip) into view, e.g. when its highlight is hovered or tapped
  function revealRule(rule) {
    if (!geo || !rule) return;
    if (geo.narrow) {
      const c = chipPos.find((x) => x.rule === rule);
      if (!c) return;
      const left = chipsEl.scrollLeft, w = geo.chips.width;
      if (c.cx - 76 < left || c.cx + 76 > left + w) chipsEl.scrollTo({ left: c.cx - w / 2, behavior: 'smooth' });
      return;
    }
    for (const side of ['L', 'R']) {
      const cg = geo[side];
      const it = cg && cg.items.get(rule);
      if (!it) continue;
      if (it.top < cg.scroll || it.top + it.h > cg.scroll + cg.H) {
        cg.sc.scrollTo({ top: Math.max(0, it.top - (cg.H - it.h) / 2), behavior: 'smooth' });
      }
    }
  }

  function setActive(rule) {
    const r = popRule || rule || null;
    if (r === active) return;
    active = r;
    for (const e of noteEls.values()) e.classList.toggle('on', e.dataset.rule === active);
    inlayDirty = true;
    schedule();
  }

  // --- hit-testing highlights in the textarea --------------------------------------------
  function spanAt(clientX, clientY) {
    if (!spans.length) return null;
    ensureRects();
    const br = bdInner.getBoundingClientRect(); // moves with the scroll
    const x = clientX - br.left, y = clientY - br.top;
    let best = null;
    spans.forEach((s, i) => {
      const rs = rects[i];
      if (!rs) return;
      for (const r of rs) {
        if (x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 2 && y <= r.y + r.h + 2) {
          if (!best || Math.abs(s.share) > Math.abs(best.s.share)) {
            best = { s, rect: { left: br.left + r.x, right: br.left + r.x + r.w, top: br.top + r.y, bottom: br.top + r.y + r.h } };
          }
          break;
        }
      }
    });
    return best;
  }

  // --- popup ---------------------------------------------------------------------------
  function placePop(anchor) {
    pop.hidden = false;
    if (narrow()) { pop.style.left = ''; pop.style.top = ''; return; }
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left, top;
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    if (!r) { left = (vw - pw) / 2; top = 80; }
    else if (anchor instanceof Element && anchor.closest('.notes-right')) { left = r.left - pw - 12; top = r.top - 8; }
    else if (anchor instanceof Element && anchor.closest('.notes-left')) { left = r.right + 12; top = r.top - 8; }
    else {
      left = r.left;
      top = r.bottom + 8;
      if (top + ph > vh - 8 && r.top - ph - 8 > 8) top = r.top - ph - 8;
    }
    left = Math.max(8, Math.min(left, vw - pw - 8));
    top = Math.max(8, Math.min(top, vh - ph - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  // Where a rule comes from. Source keys ("WP; PANGRAM-9 §2; Reinhart2025") are entries of the
  // bibliography (D.sources, listed at the end of rules.html). Three origins:
  //   paper  = research literature (AuthorYear keys), people = lists and guides written by
  //   people (upper-case keys, and the project's spec), agents = first-hand rules that agents
  //   found in the training data (no reference).
  const ORIGIN = { paper: 'Research paper', people: 'Written down by people', agents: 'Found by agents' };
  const SHORT = { WP: 'Wikipedia', 'WP-S': 'Wikipedia', GRAPHITE: 'Graphite', WAPO: 'Washington Post', ECON: 'The Economist',
    GPTZERO: 'GPTZero', A16Z: 'a16z', SLHCK: 'slhck', ARS: 'Ars Technica', SPEC: 'project spec' };
  function refsOf(m) {
    if (m.evidence === 'first-hand' || /^first-hand/.test(m.source || '')) return [{ kind: 'agents', short: 'found in the data' }];
    return (m.source || '').split(/;\s*/).filter(Boolean).map((k) => {
      const key = k.split(' ')[0], extra = k.slice(key.length).trim();
      const src = D.sources[key];
      const kind = /^[A-Z][a-z]/.test(key) ? 'paper' : 'people';
      let short = SHORT[key] || (key.startsWith('PAECH') ? 'Paech' : key.startsWith('MILD') ? 'mild-rgb' : key.startsWith('PANGRAM') ? 'Pangram' : key);
      if (kind === 'paper') {
        const y = /\d{4}/.exec(key);
        short = (src ? src.citation.split(',')[0] : key.replace(/\d.*$/, '')) + (y ? ' ' + y[0] : '');
      }
      return { kind, key, extra, src, short };
    });
  }
  function originTag(m) { // one short line for a margin note
    const refs = refsOf(m);
    if (!refs.length) return '';
    const f = refs[0];
    if (f.kind === 'agents') return 'Agents · found in the data';
    return (f.kind === 'paper' ? 'Paper · ' : 'People · ') + f.short + (refs.length > 1 ? ` +${refs.length - 1}` : '');
  }
  function originBlock(m) { // the "Where this rule comes from" part of the rule popup
    const refs = refsOf(m);
    const out = [el('p', { class: 'k', text: 'Where this rule comes from' })];
    if (!refs.length) { out.push(el('p', { class: 'note-s', text: 'No source recorded.' })); return out; }
    if (refs[0].kind === 'agents') {
      out.push(el('p', {}, el('span', { class: 'tag agents', text: ORIGIN.agents }),
        ' No reference. Agents searched half of the training texts for patterns that separate AI text from human text, ' +
        'wrote this one as a rule, and kept it because it also held on the other half.'));
      return out;
    }
    const ul = el('ul', { class: 'refs' });
    for (const r of refs) {
      const li = el('li', {}, el('span', { class: 'tag ' + r.kind, text: ORIGIN[r.kind] }), ' ');
      const cite = r.src ? r.src.citation.replace(/\*/g, '')
        : r.key === 'SPEC' ? 'The project’s spec: the author’s own list of tells.' : r.key;
      if (r.src && r.src.url) li.append(el('a', { href: r.src.url, target: '_blank', rel: 'noopener noreferrer', text: cite }));
      else if (r.src) li.append(el('a', { href: 'rules.html#src-' + r.key, text: cite }));
      else li.append(cite);
      if (r.extra) li.append(' ' + r.extra);
      ul.append(li);
    }
    out.push(ul);
    return out;
  }

  function statsGrid(pairs, cls) {
    const dl = el('dl', { class: 'stats' + (cls ? ' ' + cls : '') });
    for (const [k, v] of pairs) dl.append(el('div', {}, el('dt', { text: k }), el('dd', { text: v })));
    return dl;
  }

  function openRule(rule, anchor, refresh = false) {
    const r = A.rows.get(rule);
    if (!r) return;
    const m = r.meta, c = r.contribution, d = dirOf(c);
    const own = A.all.filter((s) => s.rule === rule);
    const count = A.hitRules.has(rule);

    const body = [];
    body.push(el('h2', { id: 'pop-title', text: m.name }));
    body.push(el('p', { class: 'fam', text: `Rule family: ${fam(m.family)} · ${m.evidence} evidence` }));
    const push = el('div', { class: 'push ' + d });
    push.append(d === 'u'
      ? 'No effect on this text'
      : el('span', {}, 'Pushes towards ', el('b', { text: DIRNAME[d] })));
    if (d !== 'u') push.append(el('b', { text: sign(c) }), el('span', { class: 'note-s', text: 'in this text' }));
    body.push(push);
    if (count) {
      const base = A.mk.baseline[rule] || 0;
      body.push(el('p', { class: 'note-s',
        text: `${sign(c - base)} from the ${own.length} highlighted hit${own.length === 1 ? '' : 's'}, ${sign(base)} ` +
          'that a text with no hits would get (the average training text has some).' }));
    }
    body.push(statsGrid([['Value', sig(r.value) + (r.imputed ? '*' : '')], ['Weight', sign(r.weight, 3)], ['Contribution', sign(c, 3)]], 's3'));
    body.push(el('p', { class: 'note-s', text: `Value in ${m.unit}` + (r.imputed ? '; * undefined for this text, so the training median is used.' : '.') +
      ' Contribution = weight × z, where z = (value − training mean) / training SD.' }));
    body.push(el('p', { class: 'k', text: 'What it looks for' }), el('p', { text: m.rationale }));
    body.push(...originBlock(m));
    if (own.length) {
      const byLabel = new Map();
      for (const s of own) {
        const k = s.text.replace(/\s+/g, ' ').trim().toLowerCase() + '\u0000' + s.d;
        const v = byLabel.get(k) || [0, 0];
        byLabel.set(k, [v[0] + 1, Math.max(v[1], Math.abs(s.share))]);
      }
      const items = [...byLabel].sort((a, b) => b[1][0] - a[1][0]);
      const ul = el('ul', { class: 'clues' });
      for (const [k, [n, w]] of items.slice(0, 12)) {
        const [lab, dir] = k.split('\u0000');
        ul.append(el('li', { class: 'fill ' + dir, style: `--k:${kSpan(w).toFixed(2)}`,
          text: (lab.length > 40 ? lab.slice(0, 38) + '…' : lab) + (n > 1 ? ` ×${n}` : '') }));
      }
      if (items.length > 12) ul.append(el('li', { text: `and ${items.length - 12} more` }));
      body.push(el('p', { class: 'k', text: `Found here (${own.length}), ${sign(own[0].share, 3)} each` }), ul);
      if (!own[0].strong && !showWeak) {
        body.push(el('p', { class: 'note-s', text: `Not highlighted: together these hits add less than ${HIT_MIN} to the logit. ` +
          'Turn on “Highlight weak evidence too” in the verdict details to see them.' }));
      }
    } else if (r.spans.length && !count) {
      body.push(el('p', { class: 'note-s', text: `A statistic of the whole text; its units (${m.spans_mean}) are not highlighted.` }));
    }
    const det = el('details', {}, el('summary', { text: 'More detail' }));
    det.append(el('p', { text: `z = (${sig(r.x)} − ${sig(r.mean)}) / ${sig(r.sd)} = ${sign(r.z)}. Observed on the training data: ${OBSERVED[m.observed] || m.observed}` +
      ((m.observed === 'AI>H') !== (r.weight >= 0) && m.observed !== 'mixed' ? ' (alone; next to the other rules the model weights it the other way).' : '.') }));
    det.append(el('p', {}, `Highlights: ${m.spans_mean}. Rule `, el('code', { text: rule }), ' · ',
      el('a', { href: 'rules.html#' + rule, text: 'entry in the rule set' })));
    body.push(det);
    showPop(rule, body, anchor, refresh);
  }

  const fired = (r) => Number.isFinite(r.value) && (r.value !== 0 || r.spans.length > 0);

  function openVerdict(anchor, refresh = false) {
    const [, long] = verdictName(A);
    const res = A.res, has = A.scored;
    const body = [el('h2', { id: 'pop-title', text: long })];
    body.push(statsGrid([['P(AI-style)', has ? res.p.toFixed(2) : '–'], ['Logit', has ? sign(res.logit) : '–'],
      ['Words', String(A.nWords)], ['Sentences', String(A.nSent)]]));
    if (A.short) {
      body.push(el('p', { class: 'note-s emph',
        text: `Under ${MIN_WORDS} words the evidence is shown but the score is withheld. The model was trained on texts of ` +
          '100 to 1,453 words, its accuracy drops at 100 words (dev AUC .92 against .98 for whole texts), and most rules ' +
          'are rates per 1,000 words, which a few words swing hard.' }));
    } else if (has) {
      const b = D.bands.bands;
      body.push(el('p', { class: 'note-s',
        text: `Bands, from out-of-fold scores of the training texts: ${b[0][1]} below ${b[1][0].toFixed(2)}, ` +
          `${b[1][1]} up to ${b[2][0].toFixed(2)}, ${b[2][1]} from ${b[2][0].toFixed(2)}.` }));
    }
    body.push(el('p', { class: 'warn' }, el('strong', { text: 'Student essays: ' }),
      'it wrongly flags about 1 in 7 student essays: 14% of essays by students not classed as English learners and ' +
      '5–6% of essays by English learners (PERSUADE and ELLIPSE, grades 6–12, all written by people), at the ' +
      'model’s default threshold of P(AI-style) ≥ 0.48. Formal school essays read as AI style to it.'));

    const rows = res.rows.slice().sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    const on = rows.filter(fired), off = rows.filter((r) => !fired(r));
    const ruleList = (rs) => {
      const ul = el('ul', { class: 'rl' });
      for (const r of rs) {
        ul.append(el('li', {}, el('button', { type: 'button', 'data-rule': r.id, text: r.meta.name }),
          el('span', { class: 'val ' + dirOf(r.contribution), text: sign(r.contribution) })));
      }
      return ul;
    };
    const sum = (rs) => rs.reduce((s, r) => s + r.contribution, 0);
    body.push(el('p', { class: 'k', text: `Rules that fired (${on.length}), by size of contribution` }), ruleList(on));
    const offDet = el('details', { class: 'off' }, el('summary', { text: `${off.length} rules that did not fire` }), ruleList(off));
    body.push(offDet);
    body.push(el('p', { class: 'k', text: 'Adding up' }));
    const tot = el('ul', { class: 'rl sum' });
    const line = (k, v, cls = '') => tot.append(el('li', { class: cls }, el('span', { text: k }), el('span', { class: 'val ' + dirOf(v), text: sign(v) })));
    line(`Sum of the ${on.length} rules that fired`, sum(on));
    line(`${off.length} rules that did not fire (value 0 or undefined)`, sum(off));
    line('Bias (intercept)', res.bias);
    if (has) line(`= logit; P(AI-style) = 1 / (1 + e^−logit) = ${res.p.toFixed(3)}`, res.logit, 'total');
    else tot.append(el('li', { class: 'total' }, el('span', { text: `Score withheld (under ${MIN_WORDS} words)` }), el('span', { text: '–' })));
    body.push(tot);
    body.push(el('p', { class: 'note-s', text: 'Contribution = weight × (value − training mean) / training SD, so a rule that did ' +
      'not fire still counts: being below the training average pushes the other way. Rules without highlights are ' +
      'statistics of the whole text (sentence lengths, word repetition, paragraphs) or have hits too weak to draw.' }));
    body.push(el('p', { class: 'acts' },
      el('button', { type: 'button', class: 'btn', 'data-act': 'weak', 'aria-pressed': String(showWeak),
        text: showWeak ? 'Highlight strong evidence only' : 'Highlight weak evidence too' }),
      el('button', { type: 'button', class: 'btn', 'data-act': 'bench', text: 'Run a speed test' })));
    body.push(el('p', { class: 'note-s', 'aria-live': 'polite',
      text: `Computed in your browser in ${A.ms.toFixed(1)} ms. ` + benchMsg }));
    body.push(el('p', { class: 'note-s' }, el('a', { href: 'about.html', text: 'About the score, the data and the examples' })));
    showPop('', body, anchor, refresh);
  }

  // In-page speed test: a 2,000-word text made of the training examples, median of 21 runs.
  function runBench() {
    if (!eng) return;
    const src = EXAMPLES.filter((e) => e.train_id);
    if (!src.length) return;
    const words = [];
    while (words.length < 2000) for (const ex of src) words.push(...ex.text.split(/\s+/).filter(Boolean));
    const text = words.slice(0, 2000).join(' ');
    const ts = [];
    for (let k = 0; k < 21; k++) { const t0 = performance.now(); eng.marks(eng.explain(text)); ts.push(performance.now() - t0); }
    ts.sort((a, b) => a - b);
    benchMsg = `Speed test, 2,000 words: median ${ts[10].toFixed(1)} ms, fastest ${ts[0].toFixed(1)} ms (21 runs).`;
  }

  function showPop(key, body, anchor, refresh) {
    const scroll = refresh ? pop.scrollTop : 0;
    const openDetails = refresh ? [...pop.querySelectorAll('details')].map((d) => d.open) : [];
    popBody.replaceChildren(...body);
    popBody.querySelectorAll('details').forEach((d, i) => { if (openDetails[i]) d.open = true; });
    popRule = key;
    popAnchor = anchor;
    if (!refresh) placePop(anchor);
    pop.scrollTop = scroll;
    setActive(key || null);
  }

  function closePop() {
    if (popRule === null) return;
    const hadFocus = pop.contains(document.activeElement);
    pop.hidden = true;
    popRule = null;
    const anchor = popAnchor;
    popAnchor = null;
    setActive(hoverRule);
    if (hadFocus && anchor instanceof Element && anchor.isConnected) anchor.focus();
  }

  // --- wiring --------------------------------------------------------------------------
  ta.addEventListener('input', () => {
    if (!prov.hidden) setProv(null);
    const t = ta.value;
    if (t !== shown) {
      shiftSpans(shown, t);
      renderBackdrop(t);
    }
    if (popRule !== null) closePop();
    scheduleAnalysis();
  });
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; scheduleAnalysis(); });
  editor.addEventListener('scroll', onScroll, { passive: true });
  for (const c of [notesL, notesR]) c.firstElementChild.addEventListener('scroll', schedule, { passive: true });
  chipsEl.addEventListener('scroll', schedule, { passive: true });
  // the textarea is as tall as its text and must never scroll by itself
  ta.addEventListener('scroll', () => { if (ta.scrollTop) ta.scrollTop = 0; }, { passive: true });

  // mouse: hover a highlight to emphasise its rule, click it for the popup
  let hoverRaf = 0, lastMove = null;
  ta.addEventListener('mousemove', (e) => {
    lastMove = e;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const hit = spanAt(lastMove.clientX, lastMove.clientY);
      const r = hit ? hit.s.rule : null;
      if (r && r !== hoverRule) revealRule(r);
      hoverRule = r;
      setActive(hoverRule);
    });
  });
  ta.addEventListener('mouseleave', () => { hoverRule = null; setActive(null); });
  // a click or tap on a highlight opens its rule (pointer events cover mouse, pen and touch)
  let down = null;
  ta.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  ta.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > (e.pointerType === 'touch' ? 8 : 5);
    down = null;
    if (moved || ta.selectionStart !== ta.selectionEnd || !A) return;
    const hit = spanAt(e.clientX, e.clientY);
    if (hit) { openRule(hit.s.rule, hit.rect); revealRule(hit.s.rule); }
    else closePop();
  });
  ta.addEventListener('pointercancel', () => { down = null; });
  // touch: a tap on a highlight while the box is not being edited should only show the rule,
  // not focus the box and raise the on-screen keyboard
  let touch = null;
  ta.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, moved: false } : null;
  }, { passive: true });
  ta.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 8) touch.moved = true;
  }, { passive: true });
  ta.addEventListener('touchend', (e) => {
    const t = touch;
    touch = null;
    if (t && !t.moved && A && document.activeElement !== ta && spanAt(t.x, t.y)) e.preventDefault();
  });

  function onNoteEvent(container) {
    container.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rule]');
      if (!b || !A) return;
      if (popRule === b.dataset.rule) { closePop(); return; }
      openRule(b.dataset.rule, b);
      if (e.detail === 0) pop.focus();
    });
    container.addEventListener('mouseover', (e) => {
      const b = e.target.closest('[data-rule]');
      hoverRule = b ? b.dataset.rule : null;
      setActive(hoverRule);
    });
    container.addEventListener('mouseleave', () => { hoverRule = null; setActive(null); });
  }
  onNoteEvent(notesL);
  onNoteEvent(notesR);
  onNoteEvent(chipsEl);

  verdictBtn.addEventListener('click', (e) => {
    if (!A) return;
    if (popRule === '') { closePop(); return; }
    openVerdict(verdictBtn);
    if (e.detail === 0) pop.focus();
  });
  popBody.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-rule]');
    if (b) { openRule(b.dataset.rule, popAnchor, false); return; }
    const act = e.target.closest('button[data-act]');
    if (!act) return;
    if (act.dataset.act === 'weak') {
      showWeak = !showWeak;
      spans = visibleSpans();
      renderBackdrop(ta.value);
    } else if (act.dataset.act === 'bench') runBench();
    openVerdict(popAnchor, true);
    const again = popBody.querySelector(`button[data-act="${act.dataset.act}"]`);
    if (again) again.focus();
  });
  pop.tabIndex = -1;
  $('pop-close').addEventListener('click', closePop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popRule !== null) closePop(); });
  document.addEventListener('pointerdown', (e) => {
    if (popRule === null) return;
    if (pop.contains(e.target) || e.target === ta || e.target.closest('[data-rule], .verdict')) return;
    closePop();
  });

  // --- examples menu: a button that opens a listbox (letter, name, tag per row) -----------
  const exTag = (e) => (e.key === 'human' ? ['o', 'human'] : e.train_id ? ['t', 'AI'] : ['t', 'AI, fresh']);
  function fillExamples() {
    exList.replaceChildren(...EXAMPLES.map((e, i) => {
      const [d, tag] = exTag(e);
      return el('li', { role: 'option', id: 'ex-opt-' + i, 'data-i': String(i), 'aria-selected': 'false', title: e.label },
        el('span', { class: 'ex-key', text: String.fromCharCode(65 + i) }),
        el('span', { class: 'ex-name', text: e.label }),
        el('span', { class: 'ex-tag fill ' + d, style: '--k:.8', text: tag }));
    }));
  }
  let exActive = 0;
  function exSetActive(i) {
    const n = EXAMPLES.length;
    if (!n) return;
    exActive = (i + n) % n;
    [...exList.children].forEach((li, k) => li.classList.toggle('active', k === exActive));
    exList.setAttribute('aria-activedescendant', 'ex-opt-' + exActive);
    exList.children[exActive].scrollIntoView({ block: 'nearest' });
  }
  function exOpen() {
    if (!EXAMPLES.length) return;
    closePop();
    exList.hidden = false;
    exBtn.setAttribute('aria-expanded', 'true');
    exSetActive(exActive);
    exList.focus();
  }
  function exClose(focusBtn) {
    if (exList.hidden) return;
    exList.hidden = true;
    exBtn.setAttribute('aria-expanded', 'false');
    if (focusBtn) exBtn.focus();
  }
  function exChoose(i) {
    const e = EXAMPLES[i];
    exClose(false);
    if (!e) return;
    exActive = i;
    [...exList.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    setText(e.text, e);
  }
  exBtn.addEventListener('click', () => (exList.hidden ? exOpen() : exClose(true)));
  exBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); exOpen(); }
  });
  exList.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown') exSetActive(exActive + 1);
    else if (k === 'ArrowUp') exSetActive(exActive - 1);
    else if (k === 'Home') exSetActive(0);
    else if (k === 'End') exSetActive(EXAMPLES.length - 1);
    else if (k === 'Enter' || k === ' ') exChoose(exActive);
    else if (k === 'Escape') exClose(true);
    else if (k === 'Tab') { exClose(false); return; }
    else {
      const j = k.length === 1 ? k.toUpperCase().charCodeAt(0) - 65 : -1;
      if (j < 0 || j >= EXAMPLES.length) return;
      exChoose(j);
    }
    e.preventDefault();
    e.stopPropagation();
  });
  exList.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) exChoose(+li.dataset.i);
  });
  exList.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && +li.dataset.i !== exActive) exSetActive(+li.dataset.i);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!exList.hidden && !e.target.closest('#exmenu')) exClose(false);
  });

  // attribution and licence of a loaded example; hidden as soon as the text is edited
  function setProv(ex) {
    if (ex) {
      const kids = [el('strong', { text: ex.label + '. ' }), ex.attribution];
      if (ex.url) kids.push(' ', el('a', { href: ex.url, target: '_blank', rel: 'noopener noreferrer', text: 'Source' }));
      prov.replaceChildren(...kids);
      prov.title = ex.label + '. ' + ex.attribution;
    }
    if (prov.hidden !== !ex) { prov.hidden = !ex; invalidate(); }
  }

  function setText(t, ex = null) {
    setProv(ex);
    ta.value = t;
    editor.scrollTop = 0;
    closePop();
    if (t !== shown) { shiftSpans(shown, t); renderBackdrop(t); }
    analyse();
  }
  $('clear').addEventListener('click', () => { setText(''); ta.focus(); });

  const ro = new ResizeObserver(() => { rects = null; invalidate(); });
  ro.observe(stage);
  ro.observe(editor);
  window.addEventListener('resize', () => { rects = null; invalidate(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { rects = null; invalidate(); });

  init();
})();
