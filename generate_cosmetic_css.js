/**
 * generate_cosmetic_css.js — renders adblock.css from cosmetic.js.
 *
 * The content script and the stylesheet must agree on the same containers, so
 * the list lives in cosmetic.js and this script keeps the CSS in sync. Run it
 * after editing cosmetic.js:
 *
 *   node generate_cosmetic_css.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ODAK_COSMETIC_GROUPS } = require('./cosmetic.js');

const header = `/* ── ODAK — Cosmetic Ad Filtering ────────────────────────────────────────── */
/*
 * Network requests are blocked natively by declarativeNetRequest. This sheet
 * only collapses the empty holes and the few ad containers that pages render
 * themselves. It costs one style recalculation and one selector pass on load —
 * no observers, no polling.
 *
 * The whole list is disabled by adding \`dh-adblock-off\` to <html>, which
 * content.js does when the feature is turned off or paused for this site.
 *
 * Generated from cosmetic.js — edit that file, then run:
 *   node generate_cosmetic_css.js
 */
`;

const allSelectors = ODAK_COSMETIC_GROUPS.flatMap(group => group.selectors);
const lastSelector = allSelectors[allSelectors.length - 1];

const body = ODAK_COSMETIC_GROUPS.map(group => {
  const lines = group.selectors.map(selector => {
    const suffix = selector === lastSelector ? '' : ',';
    return `  ${selector}${suffix}`;
  });
  return `  /* ${group.note} */\n${lines.join('\n')}`;
}).join('\n\n');

const css = `${header}html:not(.dh-adblock-off) :is(\n${body}\n) {\n  display: none !important;\n}\n`;

fs.writeFileSync(path.join(__dirname, 'adblock.css'), css);
console.log(`adblock.css written with ${allSelectors.length} selectors.`);
