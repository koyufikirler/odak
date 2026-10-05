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
        const siteKey = getSiteKey(tab.url);
        const data = await _browser.storage.local.get([siteKey, url]).catch(() => ({}));
        let elements = (siteKey && data[siteKey]) || [];

        if (siteKey && elements.length === 0 && (data[url] || []).length > 0) {
          elements = Array.from(new Set(data[url]));
          await _browser.storage.local.set({ [siteKey]: elements }).catch(() => {});
          await _browser.storage.local.remove(url).catch(() => {});
        }

        const pickMode = tab.id != null ? await getPickMode(tab.id) : false;
        sendResponse({ elements, count: elements.length, pickMode, url });

      } else if (message.action === 'addHiddenElement') {
        const url = normalizeUrl(message.url);
        const siteKey = getSiteKey(message.url);
        if (!siteKey) {
          sendResponse({ count: 0 });
          return;
        }
        const data = await _browser.storage.local.get(siteKey).catch(() => ({}));
        const elements = data[siteKey] || [];
        if (!elements.includes(message.selector)) {
          elements.push(message.selector);
          await _browser.storage.local.set({ [siteKey]: elements });
        }
        await updateBadge(tabId, elements.length);
        sendResponse({ count: elements.length });

      } else if (message.action === 'undoLast') {
        const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
        const siteKey = getSiteKey(tab.url);
        const data = await _browser.storage.local.get(siteKey).catch(() => ({}));
        let elements = (siteKey && data[siteKey]) || [];
        const removed = elements.pop();
        if (siteKey) await _browser.storage.local.set({ [siteKey]: elements });
        if (tab?.id) await updateBadge(tab.id, elements.length);
        sendResponse({ removed, count: elements.length });

      } else if (message.action === 'restoreAll') {
        const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
        const origin = normalizeOrigin(tab.url);
        const siteKey = getSiteKey(tab.url);

        const removeKeys = [];
        if (siteKey) removeKeys.push(siteKey);
        if (origin) {
          const all = await _browser.storage.local.get(null).catch(() => ({}));
          for (const k of Object.keys(all)) {
            if (k.startsWith(origin)) removeKeys.push(k);
          }
        }
        if (removeKeys.length > 0) await _browser.storage.local.remove(removeKeys).catch(() => {});

        if (tab?.id) await updateBadge(tab.id, 0);
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

      } else if (message.action === 'getAllSitesData') {
        // Return all sites that have hidden elements
        // Supports both current per-site keys (dh_site:<origin>) and legacy per-URL keys.
        const all = await _browser.storage.local.get(null).catch(() => ({}));
        const selectorsByOrigin = new Map();
        const legacyKeysToRemove = [];

        for (const [key, value] of Object.entries(all)) {
          if (!Array.isArray(value) || value.length === 0) continue;

          if (key.startsWith('dh_site:')) {
            const origin = key.replace('dh_site:', '');
            const set = selectorsByOrigin.get(origin) || new Set();
            for (const sel of value) set.add(sel);
            selectorsByOrigin.set(origin, set);
            continue;
          }

          if (key.startsWith('http://') || key.startsWith('https://')) {
            try {
              const origin = new URL(key).origin;
              const set = selectorsByOrigin.get(origin) || new Set();
              for (const sel of value) set.add(sel);
              selectorsByOrigin.set(origin, set);
              legacyKeysToRemove.push(key);
            } catch {}
          }
        }

        if (selectorsByOrigin.size > 0) {
          const write = {};
          for (const [origin, set] of selectorsByOrigin.entries()) {
            write[`dh_site:${origin}`] = Array.from(set);
          }
          await _browser.storage.local.set(write).catch(() => {});
        }

        if (legacyKeysToRemove.length > 0) {
          await _browser.storage.local.remove(legacyKeysToRemove).catch(() => {});
        }

        const sites = [];
        let totalHidden = 0;
        for (const [origin, set] of selectorsByOrigin.entries()) {
          const count = set.size;
          if (count === 0) continue;
          sites.push({ origin, count });
          totalHidden += count;
        }

        sites.sort((a, b) => b.count - a.count);
        sendResponse({ sites, totalHidden });

      } else if (message.action === 'clearAllSites') {
        // Remove all hidden element data across all sites
        const all = await _browser.storage.local.get(null).catch(() => ({}));
        const removeKeys = Object.keys(all).filter(
          k => k.startsWith('dh_site:') || k.startsWith('http://') || k.startsWith('https://')
        );
        if (removeKeys.length > 0) {
          await _browser.storage.local.remove(removeKeys).catch(() => {});
        }
        await notifyTabsAllSitesCleared();
        sendResponse({ ok: true });

      } else if (message.action === 'clearSiteData') {
        // Remove hidden element data for a specific site origin
        const origin = message.origin;
        const siteKey = `dh_site:${origin}`;
        const all = await _browser.storage.local.get(null).catch(() => ({}));
        const removeKeys = [siteKey];
        for (const k of Object.keys(all)) {
          if (
            (k.startsWith('http://') || k.startsWith('https://')) &&
            k.startsWith(origin) &&
            Array.isArray(all[k])
          ) {
            removeKeys.push(k);
          }
        }
        await _browser.storage.local.remove(removeKeys).catch(() => {});
        await notifyTabsSiteCleared(origin);
        sendResponse({ ok: true });

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

// ── Tab cleanup & badge sync ─────────────────────────────────────────────────
_browser.tabs.onRemoved.addListener(async (tabId) => {
  const key = `pickMode_${tabId}`;
  await _sessionStorage.remove(key).catch(() => {});
});

async function syncBadgeForTab(tabId) {
  try {
    const tab = await _browser.tabs.get(tabId);
    if (!tab?.url || !isInjectableTab(tab)) return;
    const url = normalizeUrl(tab.url);
    const siteKey = getSiteKey(tab.url);
    const data = await _browser.storage.local.get([siteKey, url]).catch(() => ({}));
    let elements = (siteKey && data[siteKey]) || [];
    if (siteKey && elements.length === 0 && (data[url] || []).length > 0) {
      elements = Array.from(new Set(data[url]));
      await _browser.storage.local.set({ [siteKey]: elements }).catch(() => {});
      await _browser.storage.local.remove(url).catch(() => {});
    }
    await updateBadge(tabId, elements.length);
  } catch (e) {}
}

async function notifyTabsSiteCleared(origin) {
  try {
    const tabs = await _browser.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (!tab?.id || !tab?.url || !isInjectableTab(tab)) continue;
      const tabOrigin = normalizeOrigin(tab.url);
      if (tabOrigin !== origin) continue;
      await updateBadge(tab.id, 0);
      try {
        await _browser.tabs.sendMessage(tab.id, { action: 'siteDataCleared', origin });
      } catch (e) {}
    }
  } catch (e) {}
}

async function notifyTabsAllSitesCleared() {
  try {
    const tabs = await _browser.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (!tab?.id || !tab?.url || !isInjectableTab(tab)) continue;
      await updateBadge(tab.id, 0);
      try {
        await _browser.tabs.sendMessage(tab.id, { action: 'allSitesCleared' });
      } catch (e) {}
    }
  } catch (e) {}
}

_browser.tabs.onActivated.addListener((activeInfo) => {
  syncBadgeForTab(activeInfo.tabId);
});

_browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    syncBadgeForTab(tabId);
  }
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

function normalizeOrigin(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return '';
  }
}

function getSiteKey(url) {
  const origin = normalizeOrigin(url);
  return origin ? `dh_site:${origin}` : '';
}

async function updateBadge(tabId, count) {
  if (!tabId) return;
  try {
    const text = count > 0 ? count.toString() : '';
    await _browser.action.setBadgeText({ tabId, text });
    if (count > 0) {
      await _browser.action.setBadgeBackgroundColor({ tabId, color: '#9333ea' });
    }
  } catch (e) {}
}
