/* about.js: fills about.html from the build (bands, feature count, build info) and the
 * example credits from examples.js, so they cannot drift from the detector. */
(function () {
  'use strict';
  const D = globalThis.SLOP_DATA, EX = globalThis.SLOP_EXAMPLES || [];
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  if (D) {
    const b = D.bands.bands, s = D.bands.train_shares, pc = (x) => Math.round(100 * x) + '%';
    $('n-features').textContent = String(D.model.features.length);
    $('band-text').textContent =
      `“${b[0][1]}” below ${b[1][0].toFixed(2)} (${pc(s.human.little)} of human and ${pc(s.ai.little)} of AI training texts), ` +
      `“${b[1][1]}” up to ${b[2][0].toFixed(2)}, “${b[2][1]}” from ${b[2][0].toFixed(2)} ` +
      `(${pc(s.ai['a lot'])} of AI and ${pc(s.human['a lot'])} of human training texts). ` +
      'The lower threshold is the 80th percentile of the human texts’ scores, the upper one the 20th percentile of the AI texts’ scores.';
    $('build-info').textContent = `Model ${D.build.model} (${D.build.n_features} features), export ${D.build.model_sha256.slice(0, 12)}, ` +
      `built from commit ${D.build.commit || '?'}.`;
  }
  if (EX.length) {
    $('example-credits').replaceChildren(...EX.map((ex, i) => {
      const li = el('li', {}, el('strong', { text: `${String.fromCharCode(65 + i)}. ${ex.label}: ` }), ex.attribution + ' ');
      if (ex.url) li.append(el('a', { href: ex.url, rel: 'noopener noreferrer', text: 'Source' }));
      if (ex.train_id) li.append(` (training text ${ex.train_id}).`);
      return li;
    }));
  }
})();
