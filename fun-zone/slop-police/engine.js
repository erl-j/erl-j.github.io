/* engine.js: the browser (and Node) port of the Python engine in src/slop/.
 *
 * Reads everything it can from SLOP_DATA (page/slop-data.js, written by src/build_page.py):
 * the Doc constants, every feature's metadata and declarative spec, the family params and
 * the exported LR model. So:
 *   - a new declarative feature (kind rate / presence / lexicon, e.g. from slop.port) needs no
 *     JS change: rebuild the data file;
 *   - a new hand-written (kind "code") feature needs one function in CODE below.
 *
 * Python regexes are translated (pyRegex) so that \w, \d, \s, \b, ., ^ and $ mean what they
 * mean in Python's `re` (Unicode-aware), and all regexes run with the `u` flag.
 *
 * Offsets: JS strings index UTF-16 code units, Python indexes code points. Inside the engine
 * every offset is a UTF-16 offset into doc.text (what the page highlights). The two places
 * where Python's value depends on a count of characters (the 40-character window of the
 * rule-of-three filter and the one-letter abbreviation test of the sentence splitter) count
 * code points here too. toCodePointSpans() converts spans for the parity test.
 */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.SlopEngine = E;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------------ Python regex -> JS
  // Python's str-pattern classes. \w = str.isalnum() or '_' = [\p{L}\p{N}_] (checked on every
  // code point: identical except for characters added after Unicode 15.0, Python 3.12's
  // version). \s = str.isspace(). \d = category Nd.
  const PY_W = '\\p{L}\\p{N}_';
  // JS \s = Python \s minus \x1c-\x1f and \x85, plus U+FEFF. Doc removes U+FEFF before any
  // regex runs, so [\s\x1c-\x1f\x85] is exact on every Doc view; it is also ~50x faster in
  // V8 than the explicit list (measured on the 190-phrase Pangram alternation).
  const PY_S = '\\s\\x1c-\\x1f\\x85';
  const PY_D = '\\p{Nd}';
  const WCLS = '[' + PY_W + ']';
  const BOUNDARY = '(?:(?<=' + WCLS + ')(?!' + WCLS + ')|(?<!' + WCLS + ')(?=' + WCLS + '))';
  const NONBOUNDARY = '(?:(?<=' + WCLS + ')(?=' + WCLS + ')|(?<!' + WCLS + ')(?!' + WCLS + '))';
  const SYNTAX = new Set('^$\\.*+?()[]{}|/'.split(''));
  const SIMPLE_ESC = { n: '\\n', t: '\\t', r: '\\r', f: '\\f', v: '\\v', a: '\\x07' };

  // Fast variants, used on texts with no non-ASCII letter or digit (most English text): there
  // Python's \w, \d and \b reduce to their ASCII meaning, so JS's native ones are exact and
  // several times faster than the Unicode classes. Doc picks the variant (Doc.fast).
  const FAST = { W: '\\w', WCLS: '\\w', NW: '\\W', D: '\\d', DO: '\\d', ND: '\\D', B: '\\b', NB: '\\B' };
  const EXACT = { W: PY_W, WCLS: WCLS, NW: '[^' + PY_W + ']', D: PY_D, DO: PY_D, ND: '\\P{Nd}', B: BOUNDARY, NB: NONBOUNDARY };
  // Texts with a few non-ASCII letters or digits ("café"): \w is [A-Za-z0-9_] plus exactly the
  // non-ASCII letters and digits that occur in the text. On that text this is the same set as
  // Python's \w, and V8 matches a short explicit class ~5x faster than \p{L}\p{N}.
  // Level key: 'x' + those characters (+ '|' + the Nd ones among them).
  const KITS = new Map();
  function kit(fast) {
    if (fast === 1 || fast === 2) return FAST;
    if (typeof fast !== 'string') return EXACT;
    let K = KITS.get(fast);
    if (K) return K;
    const [wx, dx] = fast.slice(1).split('|');
    const esc = chars => Array.from(chars).map(ch => '\\u{' + ch.codePointAt(0).toString(16) + '}').join('');
    const W = 'A-Za-z0-9_' + esc(wx), Wc = '[' + W + ']', Dc = '0-9' + esc(dx);
    K = { W, WCLS: Wc, NW: '[^' + W + ']', D: Dc, DO: '[' + Dc + ']', ND: '[^' + Dc + ']',
          B: '(?:(?<=' + Wc + ')(?!' + Wc + ')|(?<!' + Wc + ')(?=' + Wc + '))',
          NB: '(?:(?<=' + Wc + ')(?=' + Wc + ')|(?<!' + Wc + ')(?!' + Wc + '))' };
    KITS.set(fast, K);
    return K;
  }

  function cpEscape(cp, noU) {
    if (!noU) return '\\u{' + cp.toString(16) + '}';
    const h = x => '\\u' + x.toString(16).padStart(4, '0');
    if (cp <= 0xffff) return h(cp);
    const v = cp - 0x10000;
    return h(0xd800 + (v >> 10)) + h(0xdc00 + (v & 0x3ff));
  }

  /** fast: 0 = exact (Unicode classes), 1 = ASCII classes, 2 = ASCII classes and no `u` flag,
   *  'x...' = ASCII plus the text's own non-ASCII letters and digits (see kit). */
  function translate(p, flags, fast) {
    const K = kit(fast);
    let M = flags.indexOf('m') >= 0, S = flags.indexOf('s') >= 0, I = flags.indexOf('i') >= 0;
    let out = '', i = 0, inClass = false, classFirst = false, lastClassEsc = false, lastWordLit = false;
    const n = p.length;
    // leading global inline flags, e.g. (?i) or (?im)
    let mm;
    while ((mm = /^\(\?([aiLmsux]+)\)/.exec(p.slice(i)))) {
      if (/[aLu]/.test(mm[1]) && mm[1] !== 'u') throw new Error('unsupported inline flag in ' + p);
      if (mm[1].indexOf('i') >= 0) I = true;
      if (mm[1].indexOf('m') >= 0) M = true;
      if (mm[1].indexOf('s') >= 0) S = true;
      i += mm[0].length;
    }
    while (i < n) {
      const c = p[i];
      if (c === '\\') {
        const e = p[i + 1];
        if (e === undefined) throw new Error('trailing backslash in ' + p);
        i += 2;
        if (e !== 'b' || inClass) lastWordLit = false;
        if (inClass) {
          classFirst = false;
          if (e === 'w') { out += K.W; lastClassEsc = true; continue; }
          if (e === 'd') { out += K.D; lastClassEsc = true; continue; }
          if (e === 's') { out += PY_S; lastClassEsc = true; continue; }
          if (e === 'W' || e === 'D' || e === 'S') throw new Error('negated class escape inside [] in ' + p);
          lastClassEsc = false;
          if (e === 'b') { out += '\\x08'; continue; }
        } else {
          if (e === 'w') { out += K.WCLS; continue; }
          if (e === 'W') { out += K.NW; continue; }
          if (e === 'd') { out += K.DO; continue; }
          if (e === 'D') { out += K.ND; continue; }
          if (e === 's') { out += '[' + PY_S + ']'; continue; }
          if (e === 'S') { out += '[^' + PY_S + ']'; continue; }
          if (e === 'b' && (fast === 1 || fast === 2)) { out += K.B; continue; }
          if (e === 'b') {
            // Speed (same semantics): next to a literal word character, half of the
            // boundary test is known. "\\bx" -> "x(?<![W]x)" (starts with a literal, which
            // V8 can pre-check) and "x\\b" -> "(?![W])".
            const nx = p[i], q = p[i + 1];
            if (nx !== undefined && /[A-Za-z0-9_]/.test(nx) && !(q !== undefined && /[*+?{]/.test(q))) {
              out += nx + '(?<!' + K.WCLS + nx + ')'; i += 1; lastWordLit = true; continue;
            }
            out += lastWordLit ? '(?!' + K.WCLS + ')' : K.B;
            lastWordLit = false;
            continue;
          }
          if (e === 'B') { out += K.NB; continue; }
          if (e === 'A') { out += '(?<![\\s\\S])'; continue; }
          if (e === 'Z') { out += '(?![\\s\\S])'; continue; }
        }
        if (SIMPLE_ESC[e]) { out += SIMPLE_ESC[e]; continue; }
        if (e === 'x') { out += '\\x' + p.substr(i, 2); i += 2; continue; }
        if (e === 'u') { out += '\\u' + p.substr(i, 4); i += 4; continue; }
        if (e === 'U') { out += cpEscape(parseInt(p.substr(i, 8), 16), fast === 2); i += 8; continue; }
        if (e === '0') {
          let oct = '0';
          while (oct.length < 3 && /[0-7]/.test(p[i] || '')) oct += p[i++];
          out += cpEscape(parseInt(oct, 8), fast === 2);
          continue;
        }
        if (/[1-9]/.test(e)) {
          if (inClass) throw new Error('backreference inside [] in ' + p);
          let num = e;
          while (/[0-9]/.test(p[i] || '') && num.length < 2) num += p[i++];
          out += '(?:\\' + num + ')';
          continue;
        }
        if (/[A-Za-z0-9]/.test(e)) throw new Error('unsupported escape \\' + e + ' in ' + p);
        if (SYNTAX.has(e) || (inClass && e === '-')) out += '\\' + e;
        else out += e;
        continue;
      }
      if (inClass) {
        if (c === ']' && !classFirst) { out += ']'; inClass = false; i++; continue; }
        if (c === ']' || c === '[') { out += '\\' + c; classFirst = false; lastClassEsc = false; i++; continue; }
        if (c === '-' && lastClassEsc && p[i + 1] !== ']') { out += '\\-'; i++; lastClassEsc = false; classFirst = false; continue; }
        out += c; classFirst = false; lastClassEsc = false; i++;
        continue;
      }
      const wasWordLit = lastWordLit;
      lastWordLit = false;
      if (c === '[') {
        inClass = true; classFirst = true; lastClassEsc = false; out += '['; i++;
        if (p[i] === '^') { out += '^'; i++; }
        continue;
      }
      if (c === '.') { out += S ? '[\\s\\S]' : '[^\\n]'; i++; continue; }
      if (c === '^') { out += M ? '(?:^|(?<=\\n))' : '^'; i++; continue; }
      if (c === '$') { out += M ? '(?=\\n|(?![\\s\\S]))' : '(?=\\n?(?![\\s\\S]))'; i++; continue; }
      if (c === '(') {
        if (p[i + 1] === '?') {
          const rest = p.slice(i + 2);
          if (rest.startsWith('P<')) { out += '(?<'; i += 4; continue; }
          if (rest.startsWith('P=')) {
            const j = p.indexOf(')', i);
            out += '\\k<' + p.slice(i + 4, j) + '>'; i = j + 1; continue;
          }
          if (rest.startsWith('#')) { i = p.indexOf(')', i) + 1; continue; }
          if (/^(:|=|!|<=|<!|<[A-Za-z_])/.test(rest)) { out += '(?'; i += 2; continue; }
          throw new Error('unsupported group syntax in ' + p);
        }
        out += '('; i++; continue;
      }
      if (c === '{') {
        const q = /^\{(\d*)(?:(,)(\d*))?\}/.exec(p.slice(i));
        if (q && (q[1] !== '' || q[2])) {
          out += '{' + (q[1] || '0') + (q[2] ? ',' + q[3] : '') + '}';
          i += q[0].length;
        } else { out += '\\{'; i++; }
        continue;
      }
      if (c === '}') { out += '\\}'; i++; continue; }
      void wasWordLit;
      lastWordLit = /[A-Za-z0-9_]/.test(c) && !/[*+?{]/.test(p[i + 1] || '');
      out += c; i++;
    }
    if (inClass) throw new Error('unterminated [ in ' + p);
    return { source: out, ignoreCase: I };
  }

  const RX_CACHE = new Map();
  /** A compiled RegExp for a Python pattern. mode: 'g' (finditer/search), 'y' (match), plus
   *  'd' when group offsets are needed (m.indices; slower, so opt-in);
   *  fast: the regex level of the text (Doc.fast): 0 exact, 1 ASCII classes, 2 ASCII classes
   *  without the `u` flag (only for texts where each is exact; see Doc). */
  function pyRegex(pattern, flags, mode, fast) {
    flags = flags || '';
    mode = mode || 'g';
    fast = fast || 0;
    if (RX_CACHE.size > 5000) RX_CACHE.clear();
    const key = fast + mode + '\u0000' + flags + '\u0000' + pattern;
    let rx = RX_CACHE.get(key);
    if (!rx) {
      const t = translate(pattern, flags, fast);
      rx = new RegExp(t.source, (fast === 2 ? '' : 'u') + mode + (t.ignoreCase ? 'i' : ''));
      RX_CACHE.set(key, rx);
    }
    return rx;
  }

  /** All non-overlapping matches, Python finditer style: [{s, e, m}] (m: the exec array). */
  function finditer(rx, s) {
    const out = [];
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(s)) !== null) {
      const a = m.index, b = a + m[0].length;
      out.push(m);
      if (b === a) rx.lastIndex = a + ((s.codePointAt(a) || 0) > 0xffff ? 2 : 1);
    }
    return out;
  }
  function spansOf(rx, s) {
    return finditer(rx, s).map(m => [m.index, m.index + m[0].length]);
  }
  /** Python re.match: anchored at the start. rx must be compiled with mode 'y'. */
  function pyMatch(rx, s) {
    rx.lastIndex = 0;
    return rx.exec(s);
  }
  function pySearch(rx, s) {
    rx.lastIndex = 0;
    return rx.exec(s);
  }
  function groupSpan(m, k) {
    return m.indices[k] ? [m.indices[k][0], m.indices[k][1]] : null;
  }

  // ------------------------------------------------------------------ small helpers
  const NAN = NaN;
  const SPACE_CODES = new Set([0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
    0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
  const isSpace = ch => SPACE_CODES.has(ch.charCodeAt(0));
  const cpLen = s => { let n = 0; for (const _ of s) n++; return n; };
  const IS_ALPHA_1 = /^\p{L}$/u;
  const ALL_ND = /^\p{Nd}+$/u;
  const ASCII_ALPHA = /^[A-Za-z]+$/;

  function pyStrip(s) {
    let a = 0, b = s.length;
    while (a < b && isSpace(s[a])) a++;
    while (b > a && isSpace(s[b - 1])) b--;
    return s.slice(a, b);
  }
  function lstripChars(s, chars) {
    let a = 0;
    while (a < s.length && chars.indexOf(s[a]) >= 0) a++;
    return s.slice(a);
  }
  function rstripChars(s, chars) {
    let b = s.length;
    while (b > 0 && chars.indexOf(s[b - 1]) >= 0) b--;
    return s.slice(0, b);
  }
  function stripSpan(text, s, e) {
    while (s < e && isSpace(text[s])) s++;
    while (e > s && isSpace(text[e - 1])) e--;
    return [s, e];
  }
  const per1k = (count, d) => 1000.0 * count / d.n;
  const share = (num, den) => (den ? num / den : NAN);
  function cv(xs) {
    if (!xs.length) return NAN;
    let s = 0;
    for (const x of xs) s += x;
    const m = s / xs.length;
    if (m === 0) return NAN;
    let v = 0;
    for (const x of xs) v += (x - m) ** 2;
    return Math.sqrt(v / xs.length) / m;
  }
  const cmpSpan = (x, y) => (x[0] - y[0]) || (x[1] - y[1]);
  const sortSpans = sp => sp.sort(cmpSpan);
  function mergeSpans(spans) {
    const out = [];
    const ss = spans.filter(s => s[1] > s[0]).sort(cmpSpan);
    for (const [a, b] of ss) {
      if (out.length && a < out[out.length - 1][1]) {
        const last = out[out.length - 1];
        last[1] = Math.max(last[1], b);
      } else out.push([a, b]);
    }
    return out;
  }
  function uniqSorted(spans) {
    sortSpans(spans);
    const out = [];
    for (const s of spans) {
      const l = out[out.length - 1];
      if (!l || l[0] !== s[0] || l[1] !== s[1]) out.push(s);
    }
    return out;
  }
  /** Index `n` code points before `i` in s (Python's s[max(0, i - n):i] on code points). */
  function backCodePoints(s, i, n) {
    let j = i;
    while (n > 0 && j > 0) {
      j--;
      const c = s.charCodeAt(j);
      if (c >= 0xdc00 && c <= 0xdfff && j > 0) {
        const h = s.charCodeAt(j - 1);
        if (h >= 0xd800 && h <= 0xdbff) j--;
      }
      n--;
    }
    return j;
  }
  /** Python Counter.most_common(k): by count, ties in first-seen order (Map insertion order). */
  function mostCommon(counts, k) {
    const top = [];   // sorted by count desc, stable
    for (const e of counts) {
      if (top.length === k && e[1] <= top[k - 1][1]) continue;
      let j = top.length;
      while (j > 0 && top[j - 1][1] < e[1]) j--;
      top.splice(j, 0, e);
      if (top.length > k) top.pop();
    }
    return top;
  }

  // ------------------------------------------------------------------ the Doc
  const DOCC = new Map();   // compiled Doc constants (from SLOP_DATA.doc) per regex level
  const NONASCII_RUN = /[^\0-\x7f]+/gu;
  const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
  const ND_1 = /^\p{Nd}$/u;

  function docConstants(D, fast) {
    const k = fast || 0;
    const have = DOCC.get(k);
    if (have && have.src === D) return have;
    if (DOCC.size > 50) DOCC.clear();
    const R = (p, mode) => pyRegex(p, '', mode, k);
    const C = ({
      src: D, fast: k,
      WORD: R(D.word),
      APOS: new Map(Object.entries(D.apos)),
      SPACES: new Set(D.spaces),
      ZERO: new Set(D.zero),
      LIST_ITEM: R(D.list_item, 'y'),
      MD_HEADING: R(D.md_heading, 'y'),
      BOLD_LINE: R(D.bold_line, 'y'),
      END_PUNCT: R(D.end_punct),
      PARA_SEP: R(D.para_sep),
      SENT_END: R(D.sent_end),
      ABBREV: new Set(D.abbrev),
      NEEDS_NORM: charClass(['\r'].concat(D.spaces, D.zero)),
      APOS_RX: charClass(Object.keys(D.apos), 'g'),
      ABBREV_LSTRIP: D.abbrev_lstrip,
      ABBREV_RSTRIP: D.abbrev_rstrip,
    });
    DOCC.set(k, C);
    return C;
  }

  /** The level key of a text: see Doc. */
  function regexLevel(text, lower, opts) {
    if (opts.exact || opts.maxLevel === 0) return 0;
    const xs = new Set(), ds = new Set();
    for (const t of [text, lower]) {
      NONASCII_RUN.lastIndex = 0;
      let m;
      while ((m = NONASCII_RUN.exec(t)) !== null) {
        for (const ch of m[0]) if (LETTER_OR_NUMBER.test(ch)) { xs.add(ch); if (ND_1.test(ch)) ds.add(ch); }
      }
    }
    let lvl;
    if (!xs.size) lvl = SURROGATE.test(text) ? 1 : 2;
    else if (xs.size <= 64) lvl = 'x' + [...xs].sort().join('') + '|' + [...ds].sort().join('');
    else lvl = 0;
    if (opts.maxLevel !== undefined && typeof lvl === 'number') lvl = Math.min(lvl, opts.maxLevel);
    return lvl;
  }

  function charClass(chars, flags) {
    const body = chars.map(ch => '\\u{' + ch.codePointAt(0).toString(16) + '}').join('');
    return new RegExp('[' + body + ']', 'u' + (flags || ''));
  }

  /** slop.doc.normalise_with_map without the map (the page highlights the normalised text). */
  function normalise(raw, C) {
    const src = (raw || '').normalize('NFC');
    if (!C.NEEDS_NORM.test(src)) return src;
    const out = [];
    const n = src.length;
    for (let i = 0; i < n; i++) {
      let c = src[i];
      if (C.ZERO.has(c)) continue;
      if (c === '\r') {
        if (i + 1 < n && src[i + 1] === '\n') continue;
        c = '\n';
      } else if (C.SPACES.has(c)) c = ' ';
      out.push(c);
    }
    return out.join('');
  }

  const NON_ASCII = /[^\0-\x7f]/;
  const SURROGATE = /[\ud800-\udfff]/;
  function sameLengthLower(s) {
    const low = s.toLowerCase();
    if (!NON_ASCII.test(s)) return low;
    if (low.length === s.length && !SURROGATE.test(s) && !SURROGATE.test(low)) return low;
    if (cpLen(low) === cpLen(s)) return low;
    let out = '';
    for (const ch of s) {
      const l = ch.toLowerCase();
      out += cpLen(l) === 1 ? l : ch;
    }
    return out;
  }

  function countMatches(rx, s) {
    rx.lastIndex = 0;
    let k = 0, m;
    while ((m = rx.exec(s)) !== null) {
      k++;
      if (m[0].length === 0) rx.lastIndex = m.index + 1;
    }
    return k;
  }

  /** textnorm.sentence_ends: offsets just past each sentence end. */
  function sentenceEnds(text, C) {
    const out = [];
    for (const m of finditer(C.SENT_END, text)) {
      const pre = text.slice(0, m.index);
      let before = pre.slice(pre.lastIndexOf(' ') + 1).toLowerCase();
      before = lstripChars(before, C.ABBREV_LSTRIP);
      const g = m[0];
      if (g.startsWith('.') && rstripChars(g, C.ABBREV_RSTRIP).length === 1) {
        if (C.ABBREV.has(before) || (cpLen(before) === 1 && IS_ALPHA_1.test(before))) continue;
      }
      out.push(m.index + g.length);
    }
    return out;
  }
  function splitSentences(text, C) {
    const out = [];
    let start = 0;
    for (const e of sentenceEnds(text, C)) {
      const s = pyStrip(text.slice(start, e));
      if (s) out.push(s);
      start = e;
    }
    const tail = pyStrip(text.slice(start));
    if (tail) out.push(tail);
    return out;
  }

  class Doc {
    /** Regex level (this.fast), the fastest that is exact for this text:
     *    2    native ASCII \w \d \b without the `u` flag: no non-ASCII letter or digit (so
     *         Python's classes reduce to ASCII) and no astral character such as an emoji (so,
     *         with no surrogate pairs and no non-ASCII letters, `u` changes no match);
     *    1    the same with the `u` flag (an emoji, but no non-ASCII letter or digit);
     *    'x…' up to 64 distinct non-ASCII letters/digits ("café"): \w = [A-Za-z0-9_] plus
     *         exactly those characters, which on this text is Python's \w;
     *    0    Unicode classes \p{L}\p{N} (more than 64 such characters).
     *  opts.exact forces 0 and opts.maxLevel caps the numeric levels (the parity test runs
     *  every level). */
    constructor(raw, D, opts) {
      opts = opts || {};
      let C = docConstants(D, 0);
      this.raw = raw == null ? '' : String(raw);
      const text = normalise(this.raw, C);
      const a = text.replace(C.APOS_RX, ch => C.APOS.get(ch));
      const lower = sameLengthLower(a);
      const lvl = regexLevel(text, lower, opts);
      this.fast = lvl;
      if (lvl !== 0) C = docConstants(D, lvl);
      this.C = C;
      this.text = text;
      this.atext = a;
      this.lower = lower;
      this.cache = {};
      this._v = {};
    }
    _lazy(k, f) { return k in this._v ? this._v[k] : (this._v[k] = f.call(this)); }
    get _tok() {
      return this._lazy('_tok', function () {
        const words = [], spans = [];
        for (const m of finditer(this.C.WORD, this.atext)) {
          spans.push([m.index, m.index + m[0].length]);
          words.push(m[0].toLowerCase());
        }
        return [words, spans];
      });
    }
    get words() { return this._tok[0]; }
    get word_spans() { return this._tok[1]; }
    /** word -> its token indices (ascending), in first-seen order */
    get wordIndex() {
      return this._lazy('wordIndex', function () {
        const m = new Map();
        this.words.forEach((w, i) => { const a = m.get(w); if (a) a.push(i); else m.set(w, [i]); });
        return m;
      });
    }
    get tokens() { return this._lazy('tokens', function () { return this.word_spans.map(([s, e]) => this.atext.slice(s, e)); }); }
    get n() { return Math.max(this.words.length, 1); }
    get lines() {
      return this._lazy('lines', function () {
        const out = [], t = this.atext;
        let start = 0;
        for (let i = 0; i <= t.length; i++) {
          if (i === t.length || t[i] === '\n') {
            const [s, e] = stripSpan(t, start, i);
            if (e > s) out.push([s, e]);
            start = i + 1;
          }
        }
        return out;
      });
    }
    get paragraphs() {
      return this._lazy('paragraphs', function () {
        const out = [], t = this.atext;
        let start = 0;
        for (const m of finditer(this.C.PARA_SEP, t)) {
          const [s, e] = stripSpan(t, start, m.index);
          if (e > s) out.push([s, e]);
          start = m.index + m[0].length;
        }
        const [s, e] = stripSpan(t, start, t.length);
        if (e > s) out.push([s, e]);
        return out;
      });
    }
    get sentences() {
      return this._lazy('sentences', function () {
        const out = [], t = this.atext;
        for (const [ls, le] of this.lines) {
          const line = t.slice(ls, le);
          let start = 0;
          for (const e of sentenceEnds(line, this.C)) {
            const [s2, e2] = stripSpan(line, start, e);
            if (e2 > s2) out.push([ls + s2, ls + e2]);
            start = e;
          }
          const [s2, e2] = stripSpan(line, start, line.length);
          if (e2 > s2) out.push([ls + s2, ls + e2]);
        }
        return out;
      });
    }
    get sent_lens() {
      return this._lazy('sent_lens', function () {
        const ws = this.word_spans, out = [];
        let j = 0;
        for (const [s, e] of this.sentences) {
          while (j < ws.length && ws[j][0] < s) j++;
          let k = j;
          while (k < ws.length && ws[k][1] <= e) k++;
          out.push(k - j);
          j = k;
        }
        return out;
      });
    }
    sent_str(i) { const [s, e] = this.sentences[i]; return this.atext.slice(s, e); }
    para_str(i) { const [s, e] = this.paragraphs[i]; return this.atext.slice(s, e); }
    line_str(i) { const [s, e] = this.lines[i]; return this.atext.slice(s, e); }
    get para_word_counts() {
      return this._lazy('para_word_counts', function () {
        return this.paragraphs.map((_, i) => countMatches(this.C.WORD, this.para_str(i)));
      });
    }
    get list_items() {
      return this._lazy('list_items', function () {
        const out = [];
        for (let i = 0; i < this.lines.length; i++) if (pyMatch(this.C.LIST_ITEM, this.line_str(i))) out.push(i);
        return out;
      });
    }
    get headings() {
      return this._lazy('headings', function () {
        const C = this.C;
        const paras = new Set();
        for (let i = 0; i < this.paragraphs.length; i++) {
          const p = this.para_str(i);
          if (p.indexOf('\n') < 0) paras.add(p);
        }
        const out = [];
        for (let i = 0; i < this.lines.length; i++) {
          const ln = this.line_str(i);
          if (pyMatch(C.MD_HEADING, ln) || pyMatch(C.BOLD_LINE, ln)) out.push(i);
          else if (paras.has(ln) && !pyMatch(C.LIST_ITEM, ln) && countMatches(C.WORD, ln) <= 10
                   && !pySearch(C.END_PUNCT, ln)) out.push(i);
        }
        return out;
      });
    }
  }

  // ------------------------------------------------------------------ declarative kinds
  function regexSpans(rxs, s) {
    const all = [];
    for (const rx of rxs) for (const sp of spansOf(rx, s)) all.push(sp);
    return mergeSpans(all);
  }

  class Lexicon {
    constructor(spec) {
      this.words = new Set(spec.words || []);
      this.phrase = spec.phrase_regex || '';
    }
    hits(d) {
      const ph = [];
      if (this.phrase) for (const m of finditer(pyRegex(this.phrase, '', 'g', d.fast), d.lower)) if (m[0].length > 0) ph.push([m.index, m.index + m[0].length]);
      const out = ph.slice();
      if (this.words.size) {
        // token indices of the list's words, via the doc's word index (one lookup per type)
        const idx = [];
        for (const [w, is] of d.wordIndex) if (this.words.has(w)) for (const i of is) idx.push(i);
        idx.sort((a, b) => a - b);
        const sps = d.word_spans;
        let j = 0;
        for (const i of idx) {
          const x = sps[i][0];
          let inside = false;
          if (ph.length) {
            // ph is ascending and non-overlapping
            while (j < ph.length && ph[j][1] <= x) j++;
            inside = j < ph.length && ph[j][0] <= x;
          }
          if (!inside) out.push(sps[i]);
        }
      }
      return sortSpans(out);
    }
  }

  const VIEWS = { text: 1, atext: 1, lower: 1 };
  /** The fn(doc) -> [value, spans] of a declarative spec, or null if the kind is not declarative. */
  function buildKind(spec) {
    const kind = spec.kind;
    if (kind === 'rate' || kind === 'presence') {
      const cache = new Map();
      const rxsFor = d => {
        let r = cache.get(d.fast);
        if (!r) { r = spec.patterns.map(p => pyRegex(p, spec.flags || '', 'g', d.fast)); cache.set(d.fast, r); }
        return r;
      };
      const view = spec.view || 'atext';
      if (!VIEWS[view]) throw new Error('unknown view ' + view);
      if (kind === 'rate') return d => { const sp = regexSpans(rxsFor(d), d[view]); return [per1k(sp.length, d), sp]; };
      return d => { const sp = regexSpans(rxsFor(d), d[view]); return [sp.length ? 1.0 : 0.0, sp]; };
    }
    if (kind === 'lexicon') {
      if (!('words' in spec)) throw new Error('lexicon spec without inlined words (rebuild the ruleset)');
      const lx = new Lexicon(spec);
      return d => { const sp = lx.hits(d); return [per1k(sp.length, d), sp]; };
    }
    return null;
  }

  // ------------------------------------------------------------------ code features
  // One function per hand-written Python feature (src/slop/families/<family>.py), same name
  // as the feature id. Each reads the family params from P(family) (the JSON "params").
  let PARAMS = {};
  const PC = new Map();   // compiled params cache
  function P(fam) { return PARAMS[fam] || {}; }
  function prx(d, fam, key, flags, mode) { return pyRegex(P(fam)[key], flags || '', mode || 'g', d.fast); }
  function pset(fam, key) {
    const k = fam + '.' + key;
    let s = PC.get(k);
    if (!s) { s = new Set(P(fam)[key]); PC.set(k, s); }
    return s;
  }
  function plex(fam, key) {
    const k = fam + '.' + key + '#lex';
    let s = PC.get(k);
    if (!s) { s = new Lexicon(P(fam)[key]); PC.set(k, s); }
    return s;
  }
  const FUNCTION = () => pset('global_statistics', 'function_words');

  // -- constructions
  const TOK40 = /[\p{L}\p{N}_'-]+|,/gu;   // _TOK = r"[\w'-]+|," in constructions.py
  function rule_of_three(d) {
    const t = d.atext, sp = [];
    for (const m of finditer(prx(d, 'constructions', 'triad', 'i'), t)) {
      const before = t.slice(backCodePoints(t, m.index, 40), m.index);
      const toks = before.match(TOK40) || [];
      const last3 = toks.slice(-3);
      const end = m.index + m[0].length;
      if (last3.indexOf(',') >= 0 || t.slice(end, end + 2).startsWith(',')) continue;
      sp.push([m.index, end]);
    }
    return [per1k(sp.length, d), sp];
  }
  function formula_phrases(d) {
    const rxs = P('constructions').formula_regex.map(p => pyRegex(p, 'i', 'g', d.fast));
    const sp = plex('constructions', 'formula_list__lexicon').hits(d).concat(regexSpans(rxs, d.lower));
    return [per1k(sp.length, d), sortSpans(sp)];
  }

  // -- dramatic_beats
  function one_line_para(d) {
    const heads = new Set(d.headings.map(i => d.line_str(i)));
    const skip = prx(d, 'dramatic_beats', 'skip_para', 'i', 'y');
    const elig = [];
    for (let i = 1; i < d.paragraphs.length; i++) {
      const p = d.para_str(i);
      if (!pyMatch(skip, p) && !heads.has(p)) elig.push([p, d.paragraphs[i]]);
    }
    if (!elig.length) return [NAN, []];
    const hits = [];
    for (const [p, sp] of elig) {
      let ns = 0;
      for (const ln of p.split('\n')) ns += splitSentences(ln, d.C).length;
      if (ns === 1 && countMatches(d.C.WORD, p) <= 12) hits.push(sp);
    }
    return [hits.length / elig.length, hits];
  }
  function short_after_long(d) {
    const L = d.sent_lens;
    if (L.length < 2) return [NAN, []];
    const sp = [];
    for (let i = 0; i < L.length - 1; i++) if (L[i] >= 25 && L[i + 1] > 0 && L[i + 1] <= 6) sp.push(d.sentences[i + 1]);
    return [100.0 * sp.length / (L.length - 1), sp];
  }
  function stem(w) {
    for (const suf of ['ing', 'ed', 'es', 's']) if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
    return w;
  }
  function paraContent(d, i) {
    const s0 = d.paragraphs[i][0], F = FUNCTION(), out = [];
    for (const m of finditer(d.C.WORD, d.para_str(i))) {
      const w = m[0].toLowerCase();
      if (!F.has(w) && w.length > 2) out.push([stem(w), [s0 + m.index, s0 + m.index + m[0].length]]);
    }
    return out;
  }
  function restatement_ending(d) {
    if (d.paragraphs.length < 3) return [NAN, []];
    const a = paraContent(d, 0), b = paraContent(d, d.paragraphs.length - 1);
    const sa = new Set(a.map(x => x[0])), sb = new Set(b.map(x => x[0]));
    const both = new Set([...sa].filter(w => sb.has(w)));
    const uni = new Set([...sa, ...sb]);
    return [share(both.size, uni.size), a.concat(b).filter(x => both.has(x[0])).map(x => x[1])];
  }

  // -- global_statistics
  function ngramRep(seq, n) {
    if (seq.length < n) return [NAN, []];
    // gram keys: n small ids per gram, one UTF-16 unit each (a text has < 65536 word types)
    const ids = new Map(), code = new Array(seq.length);
    for (let i = 0; i < seq.length; i++) {
      let k = ids.get(seq[i]);
      if (k === undefined) { k = ids.size; ids.set(seq[i], k); }
      code[i] = k;
    }
    // numeric keys when n ids fit in 52 bits (always, for texts of a few thousand words)
    const bits = Math.max(1, Math.ceil(Math.log2(ids.size + 1)));
    const grams = [];
    if (bits * n <= 52) {
      const base = 2 ** bits;
      for (let i = 0; i + n <= seq.length; i++) {
        let k = 0;
        for (let j = i; j < i + n; j++) k = k * base + code[j];
        grams.push(k);
      }
    } else {
      if (ids.size >= 0xffff) throw new Error('too many word types');
      for (let i = 0; i + n <= seq.length; i++) grams.push(String.fromCharCode.apply(null, code.slice(i, i + n)));
    }
    const c = new Map();
    for (const g of grams) c.set(g, (c.get(g) || 0) + 1);
    const rep = [];
    grams.forEach((g, i) => { if (c.get(g) > 1) rep.push(i); });
    return [rep.length / grams.length, rep];
  }
  function gramSpans(d, starts, n) {
    const ws = d.word_spans, out = [];
    let end = -1;
    for (const i of starts) {
      const s = ws[i][0], e = ws[i + n - 1][1];
      if (out.length && s <= end) out[out.length - 1] = [out[out.length - 1][0], Math.max(e, end)];
      else out.push([s, e]);
      end = out[out.length - 1][1];
    }
    return out;
  }
  function ngram_repetition(d) { const [v, st] = ngramRep(d.words, 4); return [v, gramSpans(d, st, 4)]; }
  function bigram_repetition(d) { const [v, st] = ngramRep(d.words, 2); return [v, gramSpans(d, st, 2)]; }
  function template_rate(d) {
    const F = FUNCTION();
    const [v, st] = ngramRep(d.words.map(w => (F.has(w) ? w : 'X')), 5);
    return [v, gramSpans(d, st, 5)];
  }
  function sentContent(d) {
    const out = [], ws = d.word_spans, F = FUNCTION();
    let j = 0;
    for (const [s, e] of d.sentences) {
      while (j < ws.length && ws[j][0] < s) j++;
      let k = j;
      while (k < ws.length && ws[k][1] <= e) k++;
      const row = [];
      for (let i = j; i < k; i++) if (!F.has(d.words[i])) row.push([d.words[i], ws[i]]);
      out.push(row);
      j = k;
    }
    return out;
  }
  function sentence_overlap(d) {
    const sents = sentContent(d);
    const sets = sents.map(r => new Set(r.map(x => x[0])));
    const js = [], sp = [];
    for (let i = 1; i < sets.length; i++) {
      const a = sets[i - 1], b = sets[i];
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      const uni = a.size + b.size - inter;
      if (uni) {
        js.push(inter / uni);
        for (const [w, x] of sents[i]) if (a.has(w)) sp.push(x);
      }
    }
    let s = 0;
    for (const x of js) s += x;
    return [js.length ? s / js.length : NAN, sp];
  }
  function topk_word_share(d) {
    const STOP = pset('global_statistics', 'gs_stop');
    const content = [];
    for (const m of finditer(prx(d, 'global_statistics', 'gs_word'), d.text)) {
      const w = m[0].toLowerCase().split('’').join("'");
      if (!STOP.has(w) && !ALL_ND.test(w)) content.push([w, [m.index, m.index + m[0].length]]);
    }
    if (!content.length) return [0.0, []];
    const c = new Map();
    for (const [w] of content) c.set(w, (c.get(w) || 0) + 1);
    const top = mostCommon(c, 10);
    const keep = new Set(top.map(x => x[0]));
    let s = 0;
    for (const [, v] of top) s += v;
    return [s / content.length, content.filter(x => keep.has(x[0])).map(x => x[1])];
  }
  function punct_diversity(d) {
    const t = d.text, marks = P('global_statistics').punct_marks;
    const names = Object.keys(marks);
    const char2mark = new Map();
    for (const k of names) for (const ch of marks[k]) char2mark.set(ch, k);
    const dots = spansOf(/\.\.\./g, t);
    const inDots = new Set();
    for (const [a, b] of dots) for (let i = a; i < b; i++) inDots.add(i);
    const counts = {};
    for (const k of names) counts[k] = 0;
    const spans = [];
    for (let i = 0; i < t.length; i++) {
      const k = char2mark.get(t[i]);
      if (k !== undefined && !inDots.has(i)) { counts[k]++; spans.push([i, i + 1]); }
    }
    counts.ellipsis += dots.length;
    for (const s of dots) spans.push(s);
    let tot = 0;
    for (const k of names) tot += counts[k];
    if (!tot) return [0.0, []];
    let h = 0;
    for (const k of names) { const v = counts[k]; if (v) h += v / tot * Math.log2(v / tot); }
    return [-h, sortSpans(spans)];
  }
  function yules_k(d) {
    const ws = d.words;
    if (!ws.length) return [NAN, []];
    const c = new Map();
    for (const w of ws) c.set(w, (c.get(w) || 0) + 1);
    let s = 0;
    for (const v of c.values()) s += v * v;
    const n = ws.length;
    return [1e4 * (s - n) / (n * n), []];
  }

  // -- grammar
  function present_participle(d) {
    const STOP = pset('grammar', 'ing_stop'), sp = [];
    for (const m of finditer(prx(d, 'grammar', 'clause_ing', 'm', 'gd'), d.atext)) if (!STOP.has(m[1].toLowerCase())) sp.push(groupSpan(m, 1));
    for (const m of finditer(prx(d, 'grammar', 'tail_ing', 'i', 'gd'), d.atext)) if (!STOP.has(m[1].toLowerCase())) sp.push(groupSpan(m, 1));
    return [per1k(sp.length, d), sortSpans(sp)];
  }
  function whiz(key, d) {
    const NOT = pset('grammar', 'not_noun'), BE = pset('grammar', 'be_forms'), STOP = pset('grammar', 'ing_stop');
    const sp = [];
    for (const m of finditer(prx(d, 'grammar', key, 'i'), d.lower)) {
      if (NOT.has(m[1]) || BE.has(m[1]) || STOP.has(m[2])) continue;
      sp.push([m.index, m.index + m[0].length]);
    }
    return [per1k(sp.length, d), sp];
  }
  function phrasal_coordination(d) {
    const sp = spansOf(prx(d, 'grammar', 'phrasal', 'i'), d.atext).concat(spansOf(prx(d, 'grammar', 'list3', 'i'), d.atext));
    return [per1k(sp.length, d), sortSpans(sp)];
  }
  function be_main_verb(d) {
    const BE = pset('grammar', 'be_main'), PART = prx(d, 'grammar', 'participle');
    const ws = d.words, sps = d.word_spans, sp = [];
    for (let i = 0; i < ws.length; i++) {
      if (!BE.has(ws[i])) continue;
      if (ws.slice(i + 1, i + 3).some(x => pySearch(PART, x) || x === 'to')) continue;
      sp.push(sps[i]);
    }
    return [per1k(sp.length, d), sp];
  }
  function agentless_passive(d) {
    const STOP = pset('grammar', 'passive_stop'), sp = [];
    for (const m of finditer(prx(d, 'grammar', 'passive', 'i'), d.lower)) if (!STOP.has(m[1])) sp.push([m.index, m.index + m[0].length]);
    return [per1k(sp.length, d), sp];
  }
  function nominalisation(d) {
    const NOM = prx(d, 'grammar', 'nominal_suffix'), STOP = pset('grammar', 'nominal_stop'), sp = [];
    d.words.forEach((w, i) => { if (w.length >= 7 && pySearch(NOM, w) && !STOP.has(w)) sp.push(d.word_spans[i]); });
    return [per1k(sp.length, d), sp];
  }
  function attributive_adj(d) {
    const SUF = prx(d, 'grammar', 'adj_suffix'), STOP = pset('grammar', 'adj_stop'), F = FUNCTION();
    const ws = d.words, sps = d.word_spans, sp = [];
    for (let i = 0; i < ws.length - 1; i++) {
      const a = ws[i], b = ws[i + 1];
      if (a.length >= 5 && pySearch(SUF, a) && !STOP.has(a) && !a.endsWith('ment') && ASCII_ALPHA.test(b) && !F.has(b)) sp.push(sps[i]);
    }
    return [per1k(sp.length, d), sp];
  }
  function all_pronouns(d) {
    const PR = pset('grammar', 'pronouns'), sp = [];
    d.words.forEach((w, i) => { if (PR.has(w)) sp.push(d.word_spans[i]); });
    return [share(sp.length, d.words.length), sp];
  }

  // -- hedging_filler
  const PARTICLE_LSTRIP = '*_"\'“ ';
  function discourse_particles(d) {
    const rx = prx(d, 'hedging_filler', 'particle', 'i', 'y'), sp = [];
    for (const [s, e] of d.sentences) {
      const t = d.atext.slice(s, e), u = lstripChars(t, PARTICLE_LSTRIP);
      const m = pyMatch(rx, u);
      if (m) { const off = s + t.length - u.length; sp.push([off, off + m[0].length]); }
    }
    return [per1k(sp.length, d), sp];
  }

  // -- punctuation
  function oxford_comma(d) {
    const ms = finditer(prx(d, 'punctuation', 'triad_oxford'), d.text);
    if (!ms.length) return [NAN, []];
    let k = 0;
    for (const m of ms) if (m[1]) k++;
    return [k / ms.length, ms.map(m => [m.index, m.index + m[0].length])];
  }
  function irregular_marks(d) {
    const AC = pset('punctuation', 'acronyms');
    const sp = spansOf(prx(d, 'punctuation', 'irregular'), d.text);
    for (const m of finditer(prx(d, 'punctuation', 'caps'), d.text)) if (!AC.has(m[0])) sp.push([m.index, m.index + m[0].length]);
    return [per1k(sp.length, d), sortSpans(sp)];
  }
  function numbers_symbols(d) {
    const urls = spansOf(prx(d, 'punctuation', 'url', 'i'), d.text), sp = [];
    for (const m of finditer(prx(d, 'punctuation', 'num_sym'), d.text)) {
      if (!urls.some(([a, b]) => a <= m.index && m.index < b)) sp.push([m.index, m.index + m[0].length]);
    }
    return [per1k(sp.length, d), sp];
  }
  function mixed_quote_styles(d) {
    const t = d.text;
    const single = /[‘’]/.test(t) && t.indexOf("'") >= 0;
    const double = /[“”]/.test(t) && t.indexOf('"') >= 0;
    const sp = (single || double) ? spansOf(/[‘’“”'"]/g, t) : [];
    return [(single || double) ? 1.0 : 0.0, sp];
  }

  // -- statistics
  function burstiness(d) {
    const units = [];
    d.sent_lens.forEach((n, i) => { if (n > 0) units.push([n, d.sentences[i]]); });
    if (units.length < 5) return [NAN, []];
    return [cv(units.map(u => u[0])), units.map(u => u[1])];
  }
  function mean_word_length(d) {
    const ws = [];
    d.words.forEach((w, i) => { if (ASCII_ALPHA.test(w)) ws.push([w, d.word_spans[i]]); });
    if (!ws.length) return [NAN, []];
    let s = 0;
    for (const [w] of ws) s += w.length;
    return [s / ws.length, ws.filter(x => x[0].length >= 10).map(x => x[1])];
  }
  function mattrWithRepeats(ws, w) {
    if (!ws.length) return [NAN, []];
    const last = new Map(), rep = [];
    ws.forEach((t, i) => {
      const j = last.get(t);
      if (j !== undefined && i - j < w) rep.push(i);
      last.set(t, i);
    });
    if (ws.length <= w) return [new Set(ws).size / ws.length, rep];
    const c = new Map();
    for (let i = 0; i < w; i++) c.set(ws[i], (c.get(ws[i]) || 0) + 1);
    let tot = c.size;
    for (let i = w; i < ws.length; i++) {
      c.set(ws[i], (c.get(ws[i]) || 0) + 1);
      const o = ws[i - w], v = c.get(o) - 1;
      if (v === 0) c.delete(o); else c.set(o, v);
      tot += c.size;
    }
    return [tot / (ws.length - w + 1) / w, rep];
  }
  function mattr(d) {
    const [v, rep] = mattrWithRepeats(d.words, 100);
    return [v, rep.map(i => d.word_spans[i])];
  }
  function specificity(d) {
    const sp = spansOf(prx(d, 'statistics', 'digits'), d.atext);
    const ws = d.word_spans, toks = d.tokens;
    let wi = 0;
    for (const [s, e] of d.sentences) {
      while (wi < ws.length && ws[wi][0] < s) wi++;
      let k = wi, first = true;
      while (k < ws.length && ws[k][1] <= e) {
        const t = toks[k];
        if (!first && t[0] >= 'A' && t[0] <= 'Z' && t !== 'I') sp.push(ws[k]);
        first = false;
        k++;
      }
      wi = k;
    }
    for (const x of spansOf(prx(d, 'statistics', 'months'), d.atext)) sp.push(x);
    return [per1k(sp.length, d), uniqSorted(sp)];
  }
  function sentence_length_band(d) {
    const units = [];
    d.sent_lens.forEach((n, i) => { if (n > 0) units.push([n, d.sentences[i]]); });
    if (!units.length) return [NAN, []];
    const hit = units.filter(u => u[0] >= 8 && u[0] <= 20).map(u => u[1]);
    return [hit.length / units.length, hit];
  }
  function ly_adverbs(d) {
    const STOP = pset('statistics', 'ly_stop'), sp = [];
    d.words.forEach((w, i) => { if (w.length >= 5 && w.endsWith('ly') && !STOP.has(w)) sp.push(d.word_spans[i]); });
    return [per1k(sp.length, d), sp];
  }

  // -- mined (src/slop/families/mined.py)
  function article_openers(d) {
    const lead = prx(d, 'mined', 'lead', '', 'y'), A = pset('mined', 'articles'), W = d.C.WORD;
    let n = 0;
    const hits = [];
    for (const [s, e] of d.sentences) {
      const t = d.atext.slice(s, e);
      if (!pySearch(W, t)) continue;
      n++;
      const m = pyMatch(lead, t);
      W.lastIndex = m ? m[0].length : 0;
      const w = W.exec(t);
      if (w && A.has(w[0].toLowerCase())) hits.push([s + w.index, s + w.index + w[0].length]);
    }
    return [share(hits.length, n), hits];
  }
  function run_on_sentences(d) {
    const min = P('mined').run_on_min_words;
    const units = [];
    d.sent_lens.forEach((n, i) => { if (n > 0) units.push([n, d.sentences[i]]); });
    const hits = units.filter(u => u[0] >= min).map(u => u[1]);
    return [share(hits.length, units.length), hits];
  }
  function plain_period_endings(d) {
    const min = P('mined').real_sentence_min_words;
    const term = prx(d, 'mined', 'terminated'), bare = prx(d, 'mined', 'bare_period');
    const skipIdx = new Set(d.headings.concat(d.list_items));
    const skip = [...skipIdx].map(i => d.lines[i]);
    let den = 0;
    const hits = [];
    d.sentences.forEach(([s, e], i) => {
      if (d.sent_lens[i] < min || skip.some(([a, b]) => a <= s && s < b)) return;
      const t = d.atext.slice(s, e);
      if (!pySearch(term, t)) return;
      den++;
      if (pySearch(bare, t)) hits.push([e - 1, e]);
    });
    return [share(hits.length, den), hits];
  }
  function colon_lowercase(d) {
    const lo = finditer(prx(d, 'mined', 'colon_lower'), d.atext).map(m => [m.index + 1, m.index + 2]);
    const up = finditer(prx(d, 'mined', 'colon_upper'), d.atext).length;
    return [share(lo.length, lo.length + up), lo];
  }
  function hyphen_compounds(d) {
    const t = d.lower, hy = prx(d, 'mined', 'hyphen_compound'), hits = [];
    let prev = 0;
    const urls = finditer(prx(d, 'mined', 'url', 'i'), t);
    for (const m of urls.concat([null])) {
      const end = m ? m.index : t.length;
      const seg = t.slice(prev, end);
      for (const h of finditer(hy, seg)) hits.push([prev + h.index, prev + h.index + h[0].length]);
      if (m) prev = m.index + m[0].length;
    }
    return [per1k(hits.length, d), hits];
  }

  // -- structure
  function uniform_para_length(d) {
    if (d.paragraphs.length < 3) return [NAN, []];
    return [cv(d.para_word_counts), d.paragraphs.slice()];
  }
  function para_length(d) {
    if (!d.paragraphs.length) return [NAN, []];
    const c = d.para_word_counts;
    let s = 0;
    for (const x of c) s += x;
    return [s / c.length, d.paragraphs.slice()];
  }

  const CODE = {
    'constructions.rule_of_three': rule_of_three,
    'constructions.formula_phrases': formula_phrases,
    'dramatic_beats.restatement_ending': restatement_ending,
    'dramatic_beats.one_line_para': one_line_para,
    'dramatic_beats.short_after_long': short_after_long,
    'global_statistics.punct_diversity': punct_diversity,
    'global_statistics.ngram_repetition': ngram_repetition,
    'global_statistics.bigram_repetition': bigram_repetition,
    'global_statistics.template_rate': template_rate,
    'global_statistics.sentence_overlap': sentence_overlap,
    'global_statistics.topk_word_share': topk_word_share,
    'global_statistics.yules_k': yules_k,
    'grammar.present_participle': present_participle,
    'grammar.present_participle_whiz': d => whiz('whiz_ing', d),
    'grammar.past_participle_whiz': d => whiz('whiz_ed', d),
    'grammar.phrasal_coordination': phrasal_coordination,
    'grammar.be_main_verb': be_main_verb,
    'grammar.agentless_passive': agentless_passive,
    'grammar.nominalisation': nominalisation,
    'grammar.attributive_adj': attributive_adj,
    'grammar.all_pronouns': all_pronouns,
    'hedging_filler.discourse_particles': discourse_particles,
    'punctuation.oxford_comma': oxford_comma,
    'punctuation.irregular_marks': irregular_marks,
    'punctuation.numbers_symbols': numbers_symbols,
    'punctuation.mixed_quote_styles': mixed_quote_styles,
    'statistics.burstiness': burstiness,
    'statistics.mean_word_length': mean_word_length,
    'statistics.mattr': mattr,
    'statistics.specificity': specificity,
    'statistics.sentence_length_band': sentence_length_band,
    'statistics.ly_adverbs': ly_adverbs,
    'mined.article_openers': article_openers,
    'mined.run_on_sentences': run_on_sentences,
    'mined.plain_period_endings': plain_period_endings,
    'mined.colon_lowercase': colon_lowercase,
    'mined.hyphen_compounds': hyphen_compounds,
    'structure.uniform_para_length': uniform_para_length,
    'structure.para_length': para_length,
  };

  // ------------------------------------------------------------------ engine
  const MAX_SPANS = 400;

  /** An engine bound to one SLOP_DATA: compiled features in the model's order. */
  /** opts.exact: always use the Unicode-exact regex variants (for the parity test). */
  function Engine(data, opts) {
    this.opts = opts || {};
    PARAMS = data.ruleset.family_params;
    PC.clear();
    const meta = new Map(data.ruleset.features.map(f => [f.id, f]));
    const model = data.model;
    if (model.params.kind !== 'lr') throw new Error('the page port scores LR models only, got ' + model.params.kind);
    const feats = model.features.map(id => {
      const m = meta.get(id);
      if (!m) throw new Error('feature ' + id + ' is in the model but not in the ruleset');
      let fn = buildKind(m.spec);
      if (!fn) {
        fn = CODE[id];
        if (!fn) throw new Error('feature ' + id + ' (kind ' + m.spec.kind + ') has no JS function: add one to CODE in engine.js');
      }
      return { id, meta: m, fn };
    });
    this.data = data;
    this.features = feats;
    this.meta = meta;
  }
  Engine.prototype.doc = function (text) { return new Doc(text, this.data.doc, this.opts); };
  /** [{id, value, spans}] in the model's feature order. */
  Engine.prototype.compute = function (textOrDoc) {
    const d = textOrDoc instanceof Doc ? textOrDoc : this.doc(textOrDoc);
    return this.features.map(f => {
      const [v, sp] = f.fn(d);
      return { id: f.id, value: Number(v), spans: sp.slice(0, MAX_SPANS) };
    });
  };
  /** Score and explain: logit = bias + sum(contributions), exactly as slop.combiners.Scorer. */
  Engine.prototype.explain = function (text) {
    const d = this.doc(text);
    const vals = this.compute(d);
    const p = this.data.model.params, prep = p.prep;
    let sum = 0;
    const rows = vals.map((r, j) => {
      const imputed = !Number.isFinite(r.value);
      const x = imputed ? prep.median[j] : r.value;
      const z = (x - prep.mean[j]) / prep.sd[j];
      const c = z * p.w[j];
      sum += c;
      return { id: r.id, meta: this.features[j].meta, value: r.value, imputed, x, z, weight: p.w[j],
               mean: prep.mean[j], sd: prep.sd[j], contribution: c, spans: r.spans };
    });
    const logit = p.b + sum;
    return { doc: d, nWords: d.words.length, rows, bias: p.b, logit, p: 1 / (1 + Math.exp(-logit)) };
  };
  /** Evidence marks (port of slop.attribution.marks; docs/ENGINE.md, "Overlapping spans").
   *  Count features split per hit; overlapping hits of all count features merged into marks;
   *  bias + sum(baseline) + sum(rest) + sum(mark weights) == logit. */
  const U1K = 'per 1k words';
  function hitCount(meta, value, spans, n) {
    if (meta.unit !== U1K || !(meta.spans_mean || 'hits').startsWith('hits') || !Number.isFinite(value)) return null;
    const k = Math.round(value * n / 1000.0);
    if (Math.abs(1000.0 * k / n - value) > 1e-9 * Math.max(1.0, Math.abs(value))) return null;
    if (k === spans.length || (spans.length === MAX_SPANS && k > MAX_SPANS)) return k;
    return null;
  }
  Engine.prototype.marks = function (res) {
    const n = res.doc.n, baseline = {}, rest = {}, hits = [];
    for (const r of res.rows) {
      const k = hitCount(r.meta, r.value, r.spans, n);
      if (k === null) { baseline[r.id] = 0.0; rest[r.id] = r.contribution; continue; }
      const per = 1000.0 * r.weight / (r.sd * n);
      baseline[r.id] = -r.weight * r.mean / r.sd;
      rest[r.id] = (k - r.spans.length) * per;
      for (const [a, b] of r.spans) hits.push([a, b, r.id, per]);
    }
    hits.sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0) || x[3] - y[3]);
    const out = [];
    let cur = null;
    for (const [a, b, id, per] of hits) {
      if (cur === null || a >= cur.end) { cur = { start: a, end: b, weight: 0.0, parts: new Map() }; out.push(cur); }
      cur.end = Math.max(cur.end, b);
      cur.weight += per;
      const p = cur.parts.get(id);
      if (p) { p[0] += per; p[1] += 1; } else cur.parts.set(id, [per, 1]);
    }
    for (const m of out) {
      m.parts = [...m.parts.entries()].map(([id, v]) => ({ id, weight: v[0], hits: v[1] }))
        .sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight));
      m.text = res.doc.text.slice(m.start, m.end);
    }
    return { bias: res.bias, baseline, rest, marks: out, logit: res.logit };
  };

  Engine.prototype.band = function (prob) {
    const bands = this.data.bands.bands;
    let name = bands[0][1];
    for (const [lo, b] of bands) if (prob >= lo) name = b;
    return name;
  };

  /** UTF-16 offsets -> code-point offsets (for comparing with Python spans). */
  function codePointMap(s) {
    const map = new Int32Array(s.length + 1);
    let cp = 0;
    for (let i = 0; i < s.length; i++) {
      map[i] = cp;
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { map[i + 1] = cp; i++; }
      }
      cp++;
    }
    map[s.length] = cp;
    return map;
  }
  function toCodePointSpans(s, spans) {
    const map = codePointMap(s);
    return spans.map(([a, b]) => [map[a], map[b]]);
  }

  return { Engine, Doc, pyRegex, translate, finditer, sentenceEnds, splitSentences, CODE,
           toCodePointSpans, codePointMap, MAX_SPANS };
});
