/**
 * background.js — Service Worker (Chrome/Edge) & Background Script (Firefox)
 * Handles storage operations for hidden elements, relayed from content scripts.
 */

const _browser = typeof browser !== 'undefined' ? browser : chrome;

// ── Pick-mode state per tab ──────────────────────────────────────────────────
// Prefer storage.session (Chrome) — fallback to storage.local (Firefox / older Chrome)
const _sessionStorage = (() => {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) return chrome.storage.session;
  if (typeof browser !== 'undefined' && browser.storage?.session) return browser.storage.session;
  return _browser.storage.local; // fallback
})();

async function getPickMode(tabId) {
  const key = `pickMode_${tabId}`;
  const result = await _sessionStorage.get(key).catch(() => ({}));
  return result[key] || false;
}

async function setPickMode(tabId, active) {
  const key = `pickMode_${tabId}`;
  await _sessionStorage.set({ [key]: active }).catch(() => {});
}

// ── Message handler ──────────────────────────────────────────────────────────
_browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const tabId = sender.tab?.id;

      if (message.action === 'getPickMode' && tabId != null) {
        const active = await getPickMode(tabId);
        sendResponse({ active });

      } else if (message.action === 'setPickMode' && tabId != null) {
        await setPickMode(tabId, message.active);
        sendResponse({ ok: true });

      } else if (message.action === 'getHiddenElements') {
        // Popup asking for count on active tab
        const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !isInjectableTab(tab)) {
          // Restricted page (chrome://, about:, etc.) — return empty state
          sendResponse({ elements: [], count: 0, pickMode: false, url: '', restricted: true });
          return;
        }
        const url = normalizeUrl(tab.url);
        const data = await _browser.storage.local.get(url).catch(() => ({}));
        const elements = data[url] || [];
        const pickMode = tab.id != null ? await getPickMode(tab.id) : false;
        sendResponse({ elements, count: elements.length, pickMode, url });

      } else if (message.action === 'addHiddenElement') {
        const url = normalizeUrl(message.url);
        const data = await _browser.storage.local.get(url).catch(() => ({}));
        const elements = data[url] || [];
        if (!elements.includes(message.selector)) {
          elements.push(message.selector);
          await _browser.storage.local.set({ [url]: elements });
        }
        sendResponse({ count: elements.length });

      } else if (message.action === 'undoLast') {
        const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
        const url = normalizeUrl(tab.url);
        const data = await _browser.storage.local.get(url).catch(() => ({}));
        let elements = data[url] || [];
        const removed = elements.pop();
        await _browser.storage.local.set({ [url]: elements });
        sendResponse({ removed, count: elements.length });

      } else if (message.action === 'restoreAll') {
        const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
        const url = normalizeUrl(tab.url);
        await _browser.storage.local.remove(url);
        sendResponse({ ok: true });

      } else if (message.action === 'togglePickModeFromPopup') {
        const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !isInjectableTab(tab)) {
          sendResponse({ ok: false, restricted: true });
          return;
        }
        const current = await getPickMode(tab.id);
        const next = !current;
        await setPickMode(tab.id, next);
        // Ensure content script is loaded, then forward the command
        await ensureContentScript(tab.id);
        try {
          await _browser.tabs.sendMessage(tab.id, { action: 'setPickMode', active: next });
        } catch (msgErr) {
          // Content script injected but not yet ready — give it a tick
          await delay(150);
          await _browser.tabs.sendMessage(tab.id, { action: 'setPickMode', active: next });
        }
        sendResponse({ active: next });

      } else {
        sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (err) {
      console.error('[DistractionHider] background error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // Keep message channel open for async response
});

// ── Tab cleanup ──────────────────────────────────────────────────────────────
_browser.tabs.onRemoved.addListener(async (tabId) => {
  const key = `pickMode_${tabId}`;
  await _sessionStorage.remove(key).catch(() => {});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if we are allowed to inject content scripts into this tab.
 * Blocked: chrome://, edge://, about:, moz-extension://, chrome-extension://, data:, etc.
 */
function isInjectableTab(tab) {
  const url = tab?.url;
  if (!url) return false;
  const blocked = [
    'chrome://', 'chrome-extension://',
    'edge://',
    'moz-extension://', 'about:',
    'data:', 'javascript:', 'blob:',
    'file://',   // file:// requires extra permission
  ];
  return !blocked.some(prefix => url.startsWith(prefix));
}

/**
 * Ensures the content script is running in `tabId`.
 * If `tabs.sendMessage` fails with 'Receiving end does not exist', the script
 * is injected programmatically via scripting.executeScript.
 */
async function ensureContentScript(tabId) {
  try {
    // Ping the content script — if it's alive it will respond.
    await _browser.tabs.sendMessage(tabId, { action: 'getStatus' });
  } catch {
    // Not loaded yet — inject now
    await _browser.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await _browser.scripting.insertCSS({
      target: { tabId },
      files: ['content.css'],
    });
  }
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Strip hash for storage key — hash changes don't load new elements
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
