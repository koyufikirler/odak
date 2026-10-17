/**
 * content.js — Distraction Hider Content Script
 *
 * Responsibilities:
 *  1. Re-hide persisted elements on page load (silently)
 *  2. Toggle "Pick Mode" on/off when instructed by popup/background
 *  3. In Pick Mode: highlight hovered DOM elements with a glowing border
 *  4. On click: trigger Particle Dissolution effect, then hide element
 *  5. Notify background to persist the hidden element selector
 */

(() => {
  'use strict';

  const _browser = typeof browser !== 'undefined' ? browser : chrome;

  // ── Extension API helpers ─────────────────────────────────────────────────
  // After the extension is reloaded/updated, this content script keeps running in
  // the page while its extension context is gone — chrome.* calls then throw
  // *synchronously* ("Extension context invalidated"), so `.catch()` alone is not
  // enough. Every call goes through these guards and fails quietly instead.
  function safeCall(fn, fallback) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') return result.catch(() => fallback);
      return Promise.resolve(fallback);
    } catch (e) {
      return Promise.resolve(fallback);
    }
  }

  function sendToBackground(message) {
    return safeCall(() => _browser.runtime.sendMessage(message));
  }

  function storageGet(keys) {
    return safeCall(() => _browser.storage.local.get(keys), {});
  }

  function storageSet(items) {
    return safeCall(() => _browser.storage.local.set(items));
  }

  function storageRemove(keys) {
    return safeCall(() => _browser.storage.local.remove(keys));
  }

  function getMsg(key, fallback = '') {
    try {
      return _browser.i18n.getMessage(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  // ── State ────────────────────────────────────────────────────────────────
  let pickModeActive = false;
  let hoveredEl = null;
  let isAnimating = false;
  let hiddenSelectors = [];
  let actionBarEl = null;
  let pickShieldEl = null;
  let scrollUnlockState = null;
  let domObserver = null;
  let rehideTimer = null;
  let lastSeenUrl = window.location.href;
  let currentSiteKey = null;
  const SHORTCUT_STORAGE_KEY = 'dh_keyboardShortcuts';
  // Use the platform's conventional modifier for the primary shortcuts:
  //   macOS  -> Command (⌘ / Meta)
  //   Windows/Linux -> Control (Ctrl)
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const PRIMARY_MODIFIER = IS_MAC ? 'Meta' : 'Control';

  // Shortcuts are stored as strings like "Control+Alt+Shift+Meta+K". Modifiers are
  // always listed in this order so recorded values and defaults compare equal.
  const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Meta'];
  function normalizeShortcut(shortcut) {
    if (!shortcut) return shortcut;
    const parts = shortcut.split('+');
    const modifiers = MODIFIER_ORDER.filter(mod => parts.includes(mod));
    const keys = parts.filter(part => !MODIFIER_ORDER.includes(part));
    return [...modifiers, ...keys].join('+');
  }
  function normalizeShortcutMap(map) {
    const out = {};
    for (const [id, value] of Object.entries(map || {})) {
      if (value) out[id] = normalizeShortcut(value);
    }
    return out;
  }

  const DEFAULT_SHORTCUTS = {
    togglePickMode: normalizeShortcut(`${PRIMARY_MODIFIER}+Shift+P`),
    exitPickMode: 'Escape',
    undoLast: normalizeShortcut(`${PRIMARY_MODIFIER}+Shift+Z`),
    restoreAll: normalizeShortcut(`${PRIMARY_MODIFIER}+Shift+R`),
  };
  let keyboardShortcuts = { ...DEFAULT_SHORTCUTS };

  // ── DOM references ────────────────────────────────────────────────────────
  const HIGHLIGHT_CLASS = 'dh-highlight';
  const CANVAS_CLASS = 'dh-particle-canvas';
  const CURSOR_CLASS = 'dh-cursor-crosshair';
  const BLOCKED_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK']);

  // ── Initialize: restore persisted hidden elements ─────────────────────────
  async function init() {
    try {
      await loadRulesForCurrentSite();
      startDomObserver();
      startNavigationWatchers();
      scheduleRehide();
      await loadKeyboardShortcuts();
    } catch (e) {
      // Storage not available (e.g. about: pages) — ignore
    }

    // Sync pick-mode state from background (e.g. if page reloaded while active)
    try {
      const resp = await sendToBackground({ action: 'getPickMode' });
      if (resp?.active) enablePickMode();
    } catch (e) {}
  }

  async function loadKeyboardShortcuts() {
    const stored = await storageGet(SHORTCUT_STORAGE_KEY);
    keyboardShortcuts = { ...DEFAULT_SHORTCUTS, ...normalizeShortcutMap(stored[SHORTCUT_STORAGE_KEY]) };
  }

  try {
    _browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[SHORTCUT_STORAGE_KEY]) {
        keyboardShortcuts = {
          ...DEFAULT_SHORTCUTS,
          ...normalizeShortcutMap(changes[SHORTCUT_STORAGE_KEY].newValue),
        };
        updateActionBarShortcutLabel();
      }
    });
  } catch (e) {}

  // Keyboard shortcuts are attached immediately and independently of the async
  // initialisation below: even if storage or the observer fails on a page, the
  // shortcut must keep working.
  document.addEventListener('keydown', onShortcutKeyDown, true);

  init();

  function getSiteKey(url) {
    try {
      const u = new URL(url);
      return `dh_site:${u.origin}`;
    } catch {
      return null;
    }
  }

  async function loadRulesForCurrentSite() {
    const siteKey = getSiteKey(window.location.href);
    if (!siteKey) return;
    currentSiteKey = siteKey;

    const legacyUrlKey = normalizeUrl(window.location.href);
    const data = await storageGet([siteKey, legacyUrlKey]);
    const siteSelectors = data[siteKey] || [];
    const legacySelectors = data[legacyUrlKey] || [];

    if (siteSelectors.length === 0 && legacySelectors.length > 0) {
      const merged = Array.from(new Set(legacySelectors));
      hiddenSelectors = merged;
      await storageSet({ [siteKey]: merged });
      await storageRemove(legacyUrlKey);
      return;
    }

    hiddenSelectors = [...siteSelectors];
  }

  function scheduleRehide() {
    if (rehideTimer) return;
    rehideTimer = setTimeout(() => {
      rehideTimer = null;
      rehideAll();
    }, 60);
  }

  function rehideAll() {
    for (const selector of hiddenSelectors) {
      hideBySelector(selector);
    }
  }

  function startDomObserver() {
    if (domObserver) domObserver.disconnect();

    domObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const t = m.target;
        if (
          t &&
          t.nodeType === 1 &&
          (t.id === 'dh-action-bar' ||
            t.id === 'dh-pick-shield' ||
            (t.closest && (t.closest('#dh-action-bar') || t.closest('#dh-pick-shield'))) ||
            (t.classList && t.classList.contains(CANVAS_CLASS)))
        ) {
          continue;
        }
        scheduleRehide();
        break;
      }
    });

    const root = document.documentElement || document.body;
    if (!root) return;
    domObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  function startNavigationWatchers() {
    if (window.__dhNavPatched) return;
    window.__dhNavPatched = true;

    const _pushState = history.pushState;
    const _replaceState = history.replaceState;

    history.pushState = function (...args) {
      const ret = _pushState.apply(this, args);
      window.dispatchEvent(new Event('dh-locationchange'));
      return ret;
    };

    history.replaceState = function (...args) {
      const ret = _replaceState.apply(this, args);
      window.dispatchEvent(new Event('dh-locationchange'));
      return ret;
    };

    window.addEventListener('popstate', () => window.dispatchEvent(new Event('dh-locationchange')), true);
    window.addEventListener('hashchange', () => window.dispatchEvent(new Event('dh-locationchange')), true);

    window.addEventListener(
      'dh-locationchange',
      async () => {
        try {
          const url = window.location.href;
          if (url === lastSeenUrl) return;
          lastSeenUrl = url;

          const nextSiteKey = getSiteKey(url);
          if (nextSiteKey && nextSiteKey !== currentSiteKey) {
            await loadRulesForCurrentSite();
          }
          scheduleRehide();
        } catch (e) {}
      },
      true
    );
  }

  // ── Message listener (from popup / background) ────────────────────────────
  try {
    _browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.action === 'setPickMode') {
        message.active ? enablePickMode() : disablePickMode();
        sendResponse({ ok: true });
      } else if (message.action === 'undoLast') {
        undoLast();
        sendResponse({ ok: true });
      } else if (message.action === 'restoreAll') {
        restoreAll();
        sendResponse({ ok: true });
      } else if (message.action === 'siteDataCleared') {
        if (!message.origin || normalizeOrigin(window.location.href) === message.origin) {
          restoreAllLocalOnly();
        }
        sendResponse({ ok: true });
      } else if (message.action === 'allSitesCleared') {
        restoreAllLocalOnly();
        sendResponse({ ok: true });
      } else if (message.action === 'getStatus') {
        sendResponse({ pickMode: pickModeActive, count: hiddenSelectors.length });
      }
      return true;
    });
  } catch (e) {}

  // ── Pick Mode ─────────────────────────────────────────────────────────────
  function enablePickMode() {
    if (pickModeActive) return;
    pickModeActive = true;
    createActionBar();
    createPickShield();
    document.body.classList.add(CURSOR_CLASS);
    pickShieldEl.addEventListener('pointermove', onShieldPointerMove, true);
    pickShieldEl.addEventListener('pointerleave', onShieldPointerLeave, true);
    pickShieldEl.addEventListener('pointerdown', onShieldPointerDown, true);
    pickShieldEl.addEventListener('click', onShieldClick, true);
  }

  function disablePickMode() {
    if (!pickModeActive) return;
    pickModeActive = false;
    clearHighlight();
    removePickShield();
    removeActionBar();
    document.body.classList.remove(CURSOR_CLASS);
  }

  // ── Event Handlers ────────────────────────────────────────────────────────
  function getElementUnderPointer(clientX, clientY) {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (el === pickShieldEl) continue;
      if (el.id === 'dh-action-bar' || (el.closest && el.closest('#dh-action-bar'))) continue;
      return el;
    }
    return null;
  }

  function onShieldPointerDown(e) {
    if (e.pointerType !== 'touch') e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onShieldPointerMove(e) {
    const raw = getElementUnderPointer(e.clientX, e.clientY);
    const target = getValidTarget(raw);
    if (!target || target === hoveredEl) return;
    clearHighlight();
    hoveredEl = target;
    target.classList.add(HIGHLIGHT_CLASS);
  }

  function onShieldPointerLeave() {
    clearHighlight();
  }

  function onShieldClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const raw = getElementUnderPointer(e.clientX, e.clientY);
    const target = getValidTarget(raw);
    if (!target || isAnimating) return;

    clearHighlight();
    dissolveElement(target);
  }

  // Derive the key label from a KeyboardEvent. For letter/digit keys the
  // physical `event.code` is preferred: it is layout-independent and, on macOS,
  // is not affected by the accented character Option produces (e.g. ⌥K -> "˚").
  function keyLabelFromEvent(event) {
    if (event.code) {
      if (event.code.startsWith('Key')) return event.code.slice(3);
      if (event.code.startsWith('Digit')) return event.code.slice(5);
    }
    if (event.key === ' ') return 'Space';
    return event.key.length === 1 ? event.key.toUpperCase() : event.key;
  }

  function modifierPartsFromEvent(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    return parts;
  }

  function shortcutFromEvent(event) {
    return [...modifierPartsFromEvent(event), keyLabelFromEvent(event)].join('+');
  }

  // Matching accepts both the code-based label and the raw `event.key` label so
  // shortcuts recorded by older versions (which used event.key, e.g. "Alt+˚")
  // keep working.
  function shortcutCandidates(event) {
    const primary = shortcutFromEvent(event);
    let raw = event.key;
    if (raw === ' ') raw = 'Space';
    else if (raw.length === 1) raw = raw.toUpperCase();
    const legacy = [...modifierPartsFromEvent(event), raw].join('+');
    return primary === legacy ? [primary] : [primary, legacy];
  }

  function isTypingTarget(target) {
    return target instanceof Element && (
      target.matches('input, textarea, select, [contenteditable="true"]') ||
      Boolean(target.closest('[contenteditable="true"]'))
    );
  }

  function onShortcutKeyDown(event) {
    if (isTypingTarget(event.target)) return;
    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(event.key)) return; // ignore modifier-only presses
    const candidates = shortcutCandidates(event);
    const action = Object.entries(keyboardShortcuts).find(([, shortcut]) => candidates.includes(shortcut))?.[0];
    if (!action) return;

    event.preventDefault();
    event.stopPropagation();
    // If the content script was injected twice (e.g. by the popup), the same
    // shortcut would otherwise toggle twice and appear to do nothing.
    event.stopImmediatePropagation();

    if (action === 'togglePickMode') {
      setPickModeFromShortcut(!pickModeActive);
    } else if (action === 'exitPickMode' && pickModeActive) {
      setPickModeFromShortcut(false);
    } else if (action === 'undoLast') {
      undoLast();
    } else if (action === 'restoreAll') {
      restoreAll();
    }
  }

  function setPickModeFromShortcut(active) {
    active ? enablePickMode() : disablePickMode();
    sendToBackground({ action: 'setPickMode', active });
  }

  function formatShortcut(shortcut) {
    return shortcut
      .split('+')
      .map(part => (IS_MAC
        ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }[part]
        : { Control: 'Ctrl' }[part]) || part)
      .join(' + ');
  }

  function updateActionBarShortcutLabel() {
    const cancelBtn = document.getElementById('dh-cancel-btn');
    if (!cancelBtn) return;
    const done = getMsg('btnDonePlain', 'Done');
    cancelBtn.textContent = `${done} (${formatShortcut(keyboardShortcuts.exitPickMode)})`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function pauseMediaInside(el) {
    try {
      if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
        el.pause();
      }
      el.querySelectorAll('video, audio').forEach(m => m.pause());
      
      const pauseMsg = JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' });
      if (el.tagName === 'IFRAME') {
        el.contentWindow.postMessage(pauseMsg, '*');
      }
      el.querySelectorAll('iframe').forEach(ifr => {
        ifr.contentWindow.postMessage(pauseMsg, '*');
      });
    } catch (e) {}
  }

  function getValidTarget(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.closest && el.closest('#dh-action-bar')) return null; // Ignore our action bar

    // Try to capture entire video players (e.g. YouTube) so buttons aren't left behind and layout collapses
    const ytPlayer = el.closest('ytd-player');
    if (ytPlayer) {
      // Find the outermost player wrapper to collapse the reserved space
      return ytPlayer.closest('#player-full-bleed-container, #player-container-outer, #player') || ytPlayer;
    }
    const playerContainer = el.closest('.html5-video-player, .video-js, .plyr');
    if (playerContainer) return playerContainer;

    // Walk up to find a block-level or meaningful element
    let node = el;
    while (node && node !== document.documentElement) {
      if (BLOCKED_TAGS.has(node.tagName)) return null;
      const style = getComputedStyle(node);
      const isBlock = ['block', 'flex', 'grid', 'inline-block', 'table', 'list-item'].includes(style.display);
      if (isBlock && node.tagName !== 'BODY') return node;
      node = node.parentElement;
    }
    return el instanceof Element && !BLOCKED_TAGS.has(el.tagName) ? el : null;
  }

  function clearHighlight() {
    if (hoveredEl) {
      hoveredEl.classList.remove(HIGHLIGHT_CLASS);
      hoveredEl = null;
    }
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => el.classList.remove(HIGHLIGHT_CLASS));
  }

  function createPickShield() {
    if (pickShieldEl) return;
    pickShieldEl = document.createElement('div');
    pickShieldEl.id = 'dh-pick-shield';
    (document.documentElement || document.body).appendChild(pickShieldEl);
  }

  function removePickShield() {
    if (!pickShieldEl) return;
    pickShieldEl.remove();
    pickShieldEl = null;
  }

  function captureInlineStyle(el, prop) {
    return {
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
    };
  }

  function restoreInlineStyle(el, prop, snap) {
    if (!snap) return;
    if (snap.value) {
      el.style.setProperty(prop, snap.value, snap.priority);
    } else {
      el.style.removeProperty(prop);
    }
  }

  function isScrollLocked() {
    if (!document.body) return false;
    const html = document.documentElement;
    const body = document.body;
    const htmlCs = getComputedStyle(html);
    const bodyCs = getComputedStyle(body);
    const overflowLocked =
      ['hidden', 'clip'].includes(htmlCs.overflow) ||
      ['hidden', 'clip'].includes(htmlCs.overflowY) ||
      ['hidden', 'clip'].includes(bodyCs.overflow) ||
      ['hidden', 'clip'].includes(bodyCs.overflowY);

    const fixedLocked = bodyCs.position === 'fixed';
    const scrollable = Math.max(html.scrollHeight, body.scrollHeight) > window.innerHeight + 2;
    return scrollable && (overflowLocked || fixedLocked);
  }

  function shouldAttemptScrollUnlock(el) {
    if (!el || !(el instanceof Element) || !document.body) return false;
    const cs = getComputedStyle(el);
    const pos = cs.position;
    if (!['fixed', 'absolute', 'sticky'].includes(pos)) return false;

    const rect = el.getBoundingClientRect();
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const areaRatio = (Math.max(0, rect.width) * Math.max(0, rect.height)) / viewportArea;

    const z = Number.parseInt(cs.zIndex, 10);
    const highZ = Number.isFinite(z) && z >= 1000;

    const role = (el.getAttribute('role') || '').toLowerCase();
    const modalish = el.getAttribute('aria-modal') === 'true' || role === 'dialog' || role === 'alertdialog';

    return areaRatio > 0.2 || highZ || modalish;
  }

  function applyScrollUnlock() {
    if (scrollUnlockState || !document.body) return;

    const html = document.documentElement;
    const body = document.body;
    const bodyCs = getComputedStyle(body);

    let restoreY = null;
    if (bodyCs.position === 'fixed') {
      const topStr = bodyCs.top || '';
      const m = topStr.match(/-?\d+(\.\d+)?/);
      if (m) {
        const top = Number.parseFloat(m[0]);
        if (Number.isFinite(top)) restoreY = -top;
      }
    }

    scrollUnlockState = {
      html: {
        overflow: captureInlineStyle(html, 'overflow'),
        overflowY: captureInlineStyle(html, 'overflow-y'),
      },
      body: {
        overflow: captureInlineStyle(body, 'overflow'),
        overflowY: captureInlineStyle(body, 'overflow-y'),
        position: captureInlineStyle(body, 'position'),
        top: captureInlineStyle(body, 'top'),
        left: captureInlineStyle(body, 'left'),
        right: captureInlineStyle(body, 'right'),
        width: captureInlineStyle(body, 'width'),
      },
      restoreY,
    };

    html.style.setProperty('overflow', 'auto', 'important');
    html.style.setProperty('overflow-y', 'auto', 'important');
    body.style.setProperty('overflow', 'auto', 'important');
    body.style.setProperty('overflow-y', 'auto', 'important');

    if (bodyCs.position === 'fixed') {
      body.style.setProperty('position', 'static', 'important');
      body.style.setProperty('top', 'auto', 'important');
      body.style.setProperty('left', 'auto', 'important');
      body.style.setProperty('right', 'auto', 'important');
      body.style.setProperty('width', 'auto', 'important');
    }

    if (scrollUnlockState.restoreY !== null && Number.isFinite(scrollUnlockState.restoreY)) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollUnlockState.restoreY, left: 0, behavior: 'auto' });
      });
    }
  }

  function restoreScrollUnlock() {
    if (!scrollUnlockState || !document.body) return;
    const html = document.documentElement;
    const body = document.body;

    restoreInlineStyle(html, 'overflow', scrollUnlockState.html.overflow);
    restoreInlineStyle(html, 'overflow-y', scrollUnlockState.html.overflowY);

    restoreInlineStyle(body, 'overflow', scrollUnlockState.body.overflow);
    restoreInlineStyle(body, 'overflow-y', scrollUnlockState.body.overflowY);
    restoreInlineStyle(body, 'position', scrollUnlockState.body.position);
    restoreInlineStyle(body, 'top', scrollUnlockState.body.top);
    restoreInlineStyle(body, 'left', scrollUnlockState.body.left);
    restoreInlineStyle(body, 'right', scrollUnlockState.body.right);
    restoreInlineStyle(body, 'width', scrollUnlockState.body.width);

    scrollUnlockState = null;
  }

  function maybeUnlockScrollAfterHiding(el) {
    if (!isScrollLocked()) return;
    if (!shouldAttemptScrollUnlock(el)) return;
    applyScrollUnlock();
  }

  function hideBySelector(selector) {
    try {
      document.querySelectorAll(selector).forEach(el => {
        pauseMediaInside(el);
        maybeUnlockScrollAfterHiding(el);
        el.style.setProperty('display', 'none', 'important');
        el.dataset.dhHidden = 'true';
      });
    } catch (e) {}
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  }

  function normalizeOrigin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  // ── CSS Selector Generation ───────────────────────────────────────────────
  function generateSelector(el) {
    const isReasonableMatch = (sel) => {
      try {
        const n = document.querySelectorAll(sel).length;
        return n >= 1 && n <= 5;
      } catch {
        return false;
      }
    };

    // Try ID first
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
      return `#${el.id}`;
    }

    const stableAttrs = [
      'data-testid',
      'data-test',
      'data-cy',
      'data-qa',
      'data-automation-id',
      'aria-label',
      'role',
      'name',
    ];

    for (const attr of stableAttrs) {
      const raw = el.getAttribute && el.getAttribute(attr);
      if (!raw) continue;
      const value = raw.trim();
      if (!value || value.length > 80) continue;
      if (/\s/.test(value) && attr !== 'aria-label') continue;

      const candidate = `[${attr}="${CSS.escape(value)}"]`;
      if (isReasonableMatch(candidate)) return candidate;

      const tagCandidate = `${el.tagName.toLowerCase()}${candidate}`;
      if (isReasonableMatch(tagCandidate)) return tagCandidate;
    }

    const parts = [];
    let node = el;

    while (node && node !== document.documentElement && node.tagName !== 'BODY') {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;

      if (!parent) break;

      // Count same-tag siblings
      const siblings = Array.from(parent.children).filter(s => s.tagName === node.tagName);
      let part = tag;

      // Add up to 2 stable class names as hints
      const stableClasses = Array.from(node.classList)
        .filter(c => !/\b(dh-|js-|is-|has-)\b/.test(c) && c.length < 30)
        .slice(0, 2);
      if (stableClasses.length > 0) {
        part += '.' + stableClasses.map(c => CSS.escape(c)).join('.');
      } else if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
      }

      parts.unshift(part);

      // Stop if we have a unique match already
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;

      node = parent;
    }

    const path = parts.join(' > ');
    if (path) return path;

    try {
      const tag = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
      if (siblings.length <= 1) return tag;
      const idx = siblings.indexOf(el) + 1;
      return `${tag}:nth-of-type(${idx})`;
    } catch {
      return el.tagName.toLowerCase();
    }
  }

  // ── Particle Dissolution ──────────────────────────────────────────────────

  /**
   * Parse "rgb(r, g, b)" or "rgba(r, g, b, a)" → {r, g, b}
   * Returns null if not parseable.
   */
  function parseRgb(colorStr) {
    const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
  }

  /**
   * Walk up the DOM tree to find the first non-transparent background color.
   */
  function getEffectiveBgColor(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      const rgb = parseRgb(bg);
      if (rgb && !(rgb.r === 0 && rgb.g === 0 && rgb.b === 0 && bg.includes('0)'))) {
        // Skip transparent
        if (!bg.includes('rgba') || !bg.endsWith(', 0)')) return rgb;
      }
      node = node.parentElement;
    }
    return { r: 20, g: 20, b: 40 }; // Deep navy fallback
  }

  /**
   * Main dissolution: capture element visuals as particles, animate, then hide.
   */
  function dissolveElement(el) {
    isAnimating = true;
    pauseMediaInside(el);

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      finallyHide(el);
      return;
    }

    // ── Sample colors from the element ──────────────────────────────────────
    const elStyle = getComputedStyle(el);
    const bgRgb = getEffectiveBgColor(el) || { r: 80, g: 40, b: 160 };
    const fgRgb = parseRgb(elStyle.color) || { r: 220, g: 220, b: 255 };

    // Build a palette of 4–6 colors to give particles variety
    const palette = buildPalette(bgRgb, fgRgb);

    // ── Create canvas ────────────────────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    (document.documentElement || document.body).appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // ── Create particles ─────────────────────────────────────────────────────
    const area = rect.width * rect.height;
    const PARTICLE_COUNT = Math.min(Math.max(Math.floor(area / 18), 80), 1200);

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = rect.left + Math.random() * rect.width;
      const y = rect.top + Math.random() * rect.height;

      // Angle radiates from center with slight spread
      const angle = Math.atan2(y - cy, x - cx) + (Math.random() - 0.5) * 1.2;
      const dist = Math.hypot(x - cx, y - cy);
      const speed = 0.8 + Math.random() * 3.5 + dist * 0.005;

      const color = palette[Math.floor(Math.random() * palette.length)];

      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (Math.random() * 0.5), // slight upward bias
        alpha: 0.85 + Math.random() * 0.15,
        size: 1.2 + Math.random() * 2.8,
        color,
        decay: 0.008 + Math.random() * 0.016,
        twinkle: Math.random() < 0.15, // some particles twinkle
        twinklePhase: Math.random() * Math.PI * 2,
      });
    }

    // ── Add glowing sparkles on top ──────────────────────────────────────────
    const SPARKLE_COUNT = Math.min(Math.floor(PARTICLE_COUNT / 6), 50);
    for (let i = 0; i < SPARKLE_COUNT; i++) {
      const x = rect.left + Math.random() * rect.width;
      const y = rect.top + Math.random() * rect.height;
      particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 2,
        vy: -1 - Math.random() * 2,
        alpha: 1,
        size: 3 + Math.random() * 3,
        color: { r: 200, g: 160, b: 255 }, // bright violet sparkle
        decay: 0.02 + Math.random() * 0.02,
        twinkle: true,
        twinklePhase: Math.random() * Math.PI * 2,
        sparkle: true,
      });
    }

    // ── Hide element immediately (canvas covers its area) ────────────────────
    el.style.setProperty('visibility', 'hidden', 'important');

    // ── Animation loop ───────────────────────────────────────────────────────
    let frame = 0;
    let animId;

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let anyAlive = false;
      frame++;

      for (const p of particles) {
        if (p.alpha <= 0) continue;
        anyAlive = true;

        // Physics
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.04; // gravity
        p.vx *= 0.985; // horizontal drag
        p.vy *= 0.985; // vertical drag
        p.alpha -= p.decay;

        let renderAlpha = Math.max(0, p.alpha);

        if (p.twinkle) {
          p.twinklePhase += 0.15;
          renderAlpha *= 0.7 + 0.3 * Math.sin(p.twinklePhase);
        }

        if (p.sparkle) {
          // Draw a 4-point star
          drawStar(ctx, p.x, p.y, p.size, renderAlpha, p.color);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${renderAlpha})`;
          ctx.fill();
        }
      }

      if (anyAlive) {
        animId = requestAnimationFrame(animate);
      } else {
        // Animation done — fully hide element
        canvas.remove();
        finallyHide(el);
      }
    }

    animId = requestAnimationFrame(animate);
  }

  function drawStar(ctx, x, y, size, alpha, color) {
    const spikes = 4;
    const outerR = size;
    const innerR = size * 0.38;
    ctx.save();
    ctx.beginPath();
    ctx.translate(x, y);
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();

    // Glow
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.shadowBlur = size * 3;
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.fill();
    ctx.restore();
  }

  function buildPalette(bg, fg) {
    // Mix between bg and fg at various stops, plus purple/cyan accent
    const accent1 = { r: 147, g: 51, b: 234 };  // vivid purple
    const accent2 = { r: 56, g: 189, b: 248 };   // sky blue
    const accent3 = { r: 192, g: 132, b: 252 };  // lavender
    return [
      bg,
      fg,
      lerp(bg, fg, 0.4),
      lerp(bg, fg, 0.7),
      accent1,
      accent2,
      accent3,
      lerp(accent1, accent2, 0.5),
    ];
  }

  function lerp(a, b, t) {
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t),
    };
  }

  // ── Persist & finalize ────────────────────────────────────────────────────
  async function finallyHide(el) {
    el.style.removeProperty('visibility');
    pauseMediaInside(el);
    maybeUnlockScrollAfterHiding(el);
    el.style.setProperty('display', 'none', 'important');
    el.dataset.dhHidden = 'true';

    const selector = generateSelector(el);
    hiddenSelectors.push(selector);

    isAnimating = false;
    updateActionBarCount();

    try {
      await sendToBackground({
        action: 'addHiddenElement',
        url: window.location.href,
        selector,
      });
    } catch (e) {}
  }

  // ── Undo / Restore ────────────────────────────────────────────────────────
  async function undoLast() {
    try {
      const resp = await sendToBackground({ action: 'undoLast' });
      if (resp?.removed) {
        const selector = resp.removed;
        hiddenSelectors = hiddenSelectors.filter(s => s !== selector);
        document.querySelectorAll(selector).forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.dhHidden;
        });
        updateActionBarCount();
        if (hiddenSelectors.length === 0) restoreScrollUnlock();
      }
    } catch (e) {}
  }

  async function restoreAll() {
    try {
      await sendToBackground({ action: 'restoreAll' });
      restoreAllLocalOnly();
    } catch (e) {}
  }

  function restoreAllLocalOnly() {
    document.querySelectorAll('[data-dh-hidden]').forEach(el => {
      el.style.removeProperty('display');
      delete el.dataset.dhHidden;
    });
    hiddenSelectors = [];
    updateActionBarCount();
    restoreScrollUnlock();
  }

  // ── Floating Action Bar ───────────────────────────────────────────────────
  function createActionBar() {
    if (actionBarEl) return;
    
    // Fetch localized strings (fallback to English if not available)
    const strHidden = getMsg('barHidden', 'Hidden:');
    const strUndo = getMsg('btnUndo', 'Undo Last');
    const strRestore = getMsg('btnRestore', 'Restore All');
    const strDone = getMsg('btnDone', 'Done (Esc)');

    actionBarEl = document.createElement('div');
    actionBarEl.id = 'dh-action-bar';

    // Count badge
    const countBadge = document.createElement('span');
    countBadge.className = 'dh-count-badge';
    const countLabel = document.createTextNode(strHidden + ' ');
    const countSpan = document.createElement('span');
    countSpan.id = 'dh-hidden-count';
    countSpan.textContent = String(hiddenSelectors.length);
    countBadge.appendChild(countLabel);
    countBadge.appendChild(countSpan);

    // Undo button
    const undoBtn = document.createElement('button');
    undoBtn.id = 'dh-undo-btn';
    undoBtn.textContent = strUndo;
    if (hiddenSelectors.length === 0) undoBtn.disabled = true;

    // Restore button
    const restoreBtn = document.createElement('button');
    restoreBtn.id = 'dh-restore-btn';
    restoreBtn.textContent = strRestore;
    if (hiddenSelectors.length === 0) restoreBtn.disabled = true;

    // Done / cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'dh-cancel-btn';
    cancelBtn.className = 'dh-cancel-btn';
    cancelBtn.textContent = strDone;

    actionBarEl.appendChild(countBadge);
    actionBarEl.appendChild(undoBtn);
    actionBarEl.appendChild(restoreBtn);
    actionBarEl.appendChild(cancelBtn);
    (document.documentElement || document.body).appendChild(actionBarEl);

    document.getElementById('dh-undo-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      undoLast();
    });
    document.getElementById('dh-restore-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      restoreAll();
    });
    document.getElementById('dh-cancel-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      disablePickMode();
      sendToBackground({ action: 'setPickMode', active: false });
    });
  }

  function removeActionBar() {
    if (actionBarEl) {
      actionBarEl.remove();
      actionBarEl = null;
    }
  }

  function updateActionBarCount() {
    if (!actionBarEl) return;
    const countEl = document.getElementById('dh-hidden-count');
    if (countEl) countEl.textContent = hiddenSelectors.length;
    
    const undoBtn = document.getElementById('dh-undo-btn');
    const restoreBtn = document.getElementById('dh-restore-btn');
    if (undoBtn) undoBtn.disabled = hiddenSelectors.length === 0;
    if (restoreBtn) restoreBtn.disabled = hiddenSelectors.length === 0;
  }
})();
