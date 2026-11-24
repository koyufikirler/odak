/**
 * cosmetic.js — the exact containers ODAK collapses on every page.
 *
 * This is the single source of truth for the cosmetic filter. It is loaded
 * before content.js (see manifest.json) so the content script can count what
 * the stylesheet removed, and `generate_cosmetic_css.js` renders adblock.css
 * from the same list. Edit here, then run:
 *
 *   node generate_cosmetic_css.js
 *
 * Only exact, well-known container names are used. Bare `.ad` / `.ads` and
 * substring matches are deliberately avoided: in several languages "ad" means
 * "name", and substrings like "download-banner" contain "ad-banner".
 */
'use strict';

// Declared with `var` on purpose: background.js can re-inject this file when a
// tab is slow to answer, and a second top-level `const` would throw a
// redeclaration error and prevent content.js from starting.
var ODAK_COSMETIC_GROUPS = [
  {
    note: 'Google AdSense, Ad Manager and AMP ads',
    selectors: [
      'ins.adsbygoogle',
      '[id^="google_ads_"]',
      '[id^="div-gpt-ad"]',
      '[id^="gpt-passback"]',
      '[id^="aswift_"]',
      'iframe[id^="google_ads_iframe"]',
      '[data-ad-slot]',
      '[data-ad-client]',
      '[data-ad-unit]',
      '[data-adunit]',
      '[data-google-query-id]',
      'amp-ad',
    ],
  },
  {
    note: 'Common publisher slots',
    selectors: [
      '.ad-slot',
      '.ad-unit',
      '.ad-container',
      '.ad-wrapper',
      '.ad-banner',
      '.ad-placeholder',
      '.advertisement',
      '.advertisement-container',
      '[id^="ad-slot-"]',
      '[id^="ad-unit-"]',
      '[id^="ad-container-"]',
      '[id^="ad-banner-"]',
      '[aria-label="Advertisement" i]',
      '[aria-label="Ads" i]',
    ],
  },
  {
    note: 'Ad iframes from known networks',
    selectors: [
      'iframe[src*="doubleclick.net"]',
      'iframe[src*="googlesyndication.com"]',
      'iframe[src*="googleadservices.com"]',
      'iframe[src*="amazon-adsystem.com"]',
    ],
  },
  {
    note: 'Taboola / Outbrain / native networks',
    selectors: [
      '.taboola',
      '[id^="taboola-"]',
      '.trc_related_container',
      '.trc_rbox_container',
      '.outbrain',
      '.OUTBRAIN',
      '[id^="outbrain_widget"]',
      '.ob-widget',
      '.ob-smartfeed-wrapper',
      '[id^="criteo-"]',
      '[class^="criteo-"]',
      '[class*=" criteo-"]',
      '[id^="amzn-assoc-ad"]',
      '.native-ad',
      '.native-ad-container',
      '.mgid',
      '[id^="mgid-"]',
      '.revcontent',
      '[id^="revcontent"]',
      '.zergnet',
      '[id^="zergnet"]',
      '.dianomi',
      '[id^="dianomi"]',
      '[class^="teads-"]',
      '[class*=" teads-"]',
    ],
  },
  {
    note: 'Publisher ad platforms',
    selectors: [
      '.ezoic-ad',
      '[id^="ezoic-"]',
      '.adthrive-ad',
      '.adthrive-content',
      '.adthrive-footer',
      '.adthrive-video-player',
      '[id^="mediavine-"]',
    ],
  },
  {
    note: 'Feed ads on YouTube and Reddit',
    selectors: [
      '#masthead-ad',
      'ytd-ad-slot-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-display-ad-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-companion-slot-renderer',
      'ytd-banner-promo-renderer',
      'ytd-statement-banner-renderer',
      'shreddit-ad-post',
    ],
  },
];

var ODAK_COSMETIC_SELECTOR = `:is(${ODAK_COSMETIC_GROUPS
  .flatMap(group => group.selectors)
  .join(', ')})`;

// Content scripts share one isolated world, so content.js can read these.
if (typeof globalThis !== 'undefined') {
  globalThis.ODAK_COSMETIC_GROUPS = ODAK_COSMETIC_GROUPS;
  globalThis.ODAK_COSMETIC_SELECTOR = ODAK_COSMETIC_SELECTOR;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ODAK_COSMETIC_GROUPS, ODAK_COSMETIC_SELECTOR };
}
