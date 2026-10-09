/**
 * popup.js — Distraction Hider Popup Logic & Navigation
 *
 * Communicates with background.js to:
 *  - Toggle Pick Mode on the active tab
 *  - Display hidden element count
 *  - Trigger Undo Last / Restore All via content script
 *  - Handle Navigation (Settings Drawer & Subview Tabs)
 */

'use strict';

const _browser = typeof browser !== 'undefined' ? browser : chrome;

// ── DOM references ────────────────────────────────────────────────────────
const pickCheckbox     = document.getElementById('pick-mode-checkbox');
const pickCard         = document.getElementById('pick-mode-section');
const pickStatus       = document.getElementById('pick-mode-status');
const hintText         = document.getElementById('hint-text');
const hiddenCount      = document.getElementById('hidden-count');
const statusBadge      = document.getElementById('status-badge');
const badgeText        = document.getElementById('badge-text');
const undoBtn          = document.getElementById('undo-btn');
const restoreBtn       = document.getElementById('restore-btn');

// Menu, Tabs & Views
const settingsBtn      = document.getElementById('settings-btn');
const menuDrawer       = document.getElementById('menu-drawer');
const menuOverlay      = document.getElementById('menu-overlay');
const closeMenuBtn     = document.getElementById('close-menu-btn');
const menuItems        = document.querySelectorAll('.menu-item');
const subviewTabs      = document.querySelectorAll('.subview-tab');

const viewMain         = document.getElementById('view-main');
const viewSites        = document.getElementById('view-sites');
const viewAbout        = document.getElementById('view-about');
const viewDonate       = document.getElementById('view-donate');
const aboutBackBtn     = document.getElementById('about-back-btn');
const donateBackBtn    = document.getElementById('donate-back-btn');
const sitesBackBtn     = document.getElementById('sites-back-btn');
const sitesList        = document.getElementById('sites-list');
const sitesEmpty       = document.getElementById('sites-empty');
const sitesTotalCount  = document.getElementById('sites-total-count');
const clearAllSitesBtn = document.getElementById('clear-all-sites-btn');
const navSitesBadge    = document.getElementById('nav-sites-badge');

let currentView = 'main';

// ── Initialize popup state ────────────────────────────────────────────────
async function init() {
  // Apply i18n strings
  applyI18n();

  // Setup navigation listeners
  setupNavigation();

  try {
    const resp = await _browser.runtime.sendMessage({ action: 'getHiddenElements' });
    if (!resp) return;

    if (resp.restricted) {
      setRestrictedUI();
      return;
    }

    updateCount(resp.count);
    updatePickUI(resp.pickMode);
    updateButtons(resp.count);
  } catch (e) {
    setRestrictedUI();
  }
}

// ── Internationalization helper ───────────────────────────────────────────
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = _browser.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const msg = _browser.i18n.getMessage(key);
    if (msg) el.setAttribute('title', msg);
  });
}

// ── Navigation & Drawer ───────────────────────────────────────────────────
function openMenu() {
  menuDrawer.classList.add('open');
  menuOverlay.classList.add('open');
}

function closeMenu() {
  menuDrawer.classList.remove('open');
  menuOverlay.classList.remove('open');
}

function switchView(viewName, shouldCloseDrawer = true) {
  currentView = viewName;

  // Hide all views
  viewMain.classList.remove('active');
  viewSites.classList.remove('active');
  viewAbout.classList.remove('active');
  viewDonate.classList.remove('active');

  // Show target view
  if (viewName === 'sites') {
    viewSites.classList.add('active');
    loadSitesData();
  } else if (viewName === 'about') {
    viewAbout.classList.add('active');
  } else if (viewName === 'donate') {
    viewDonate.classList.add('active');
  } else {
    viewMain.classList.add('active');
  }

  // Update drawer menu items active state
  menuItems.forEach(item => {
    const target = item.getAttribute('data-view');
    if (target === viewName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update subview tab bar items active state
  document.querySelectorAll('.subview-tab').forEach(tab => {
    const target = tab.getAttribute('data-view');
    if (target === viewName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  if (shouldCloseDrawer) {
    closeMenu();
  }
}

function setupNavigation() {
  settingsBtn.addEventListener('click', () => {
    switchView('about', false);
    openMenu();
  });
  closeMenuBtn.addEventListener('click', closeMenu);
  menuOverlay.addEventListener('click', closeMenu);

  // Drawer menu items click
  menuItems.forEach(item => {
    item.addEventListener('click', () => {
      const view = item.getAttribute('data-view');
      switchView(view, true);
    });
  });

  // Subview quick tab switcher click (instant 1-click toggle between About Us and Donate)
  subviewTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.getAttribute('data-view');
      switchView(view, true);
    });
  });

  aboutBackBtn.addEventListener('click', () => switchView('main', true));
  donateBackBtn.addEventListener('click', () => switchView('main', true));
  sitesBackBtn.addEventListener('click', () => switchView('main', true));

  // Handle external donate links safely
  document.querySelectorAll('.btn-donate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const href = btn.getAttribute('href');
      if (href && _browser.tabs?.create) {
        e.preventDefault();
        _browser.tabs.create({ url: href });
      }
    });
  });

  // Handle Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menuDrawer.classList.contains('open')) {
        closeMenu();
        e.stopPropagation();
      } else if (currentView !== 'main') {
        switchView('main', true);
        e.stopPropagation();
      }
    }
  });
}

// ── Toggle Pick Mode ──────────────────────────────────────────────────────
pickCheckbox.addEventListener('change', async () => {
  try {
    const resp = await _browser.runtime.sendMessage({ action: 'togglePickModeFromPopup' });
    if (resp?.restricted) {
      // Revert toggle — page not injectable
      pickCheckbox.checked = !pickCheckbox.checked;
      setRestrictedUI();
      return;
    }
    if (resp) {
      updatePickUI(resp.active);
      if (resp.active) {
        window.close();
      }
    }
  } catch (e) {
    pickCheckbox.checked = !pickCheckbox.checked; // revert on error
  }
});

// ── Undo Last ─────────────────────────────────────────────────────────────
undoBtn.addEventListener('click', async () => {
  try {
    undoBtn.disabled = true;
    const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
    // Instruct content script to undo last
    await _browser.tabs.sendMessage(tab.id, { action: 'undoLast' });

    // Refresh count from background
    const state = await _browser.runtime.sendMessage({ action: 'getHiddenElements' });
    if (state) {
      updateCount(state.count);
      updateButtons(state.count);
    }
  } catch (e) {
    updateButtons(0);
  }
});

// ── Restore All ───────────────────────────────────────────────────────────
restoreBtn.addEventListener('click', async () => {
  try {
    restoreBtn.disabled = true;
    const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });
    await _browser.tabs.sendMessage(tab.id, { action: 'restoreAll' });
    updateCount(0);
    updateButtons(0);
  } catch (e) {
    updateButtons(0);
  }
});

// ── UI Helpers ────────────────────────────────────────────────────────────
function updatePickUI(active) {
  pickCheckbox.checked = active;

  if (active) {
    pickCard.classList.add('active');
    statusBadge.classList.add('active');
    badgeText.textContent = _browser.i18n.getMessage('badgeActive');
    pickStatus.textContent = _browser.i18n.getMessage('pickModeActive');
    hintText.textContent = _browser.i18n.getMessage('pickHintActive');
  } else {
    pickCard.classList.remove('active');
    statusBadge.classList.remove('active');
    badgeText.textContent = _browser.i18n.getMessage('badgeInactive');
    pickStatus.textContent = _browser.i18n.getMessage('pickModeInactive');
    hintText.textContent = _browser.i18n.getMessage('pickHintInactive');
  }
}

function updateCount(count) {
  const prev = parseInt(hiddenCount.textContent, 10) || 0;
  hiddenCount.textContent = count;
  if (count !== prev) {
    hiddenCount.classList.remove('count-animate');
    // Trigger reflow to restart animation
    void hiddenCount.offsetWidth;
    hiddenCount.classList.add('count-animate');
  }
}

function updateButtons(count) {
  undoBtn.disabled    = count === 0;
  restoreBtn.disabled = count === 0;
}

function setRestrictedUI() {
  pickCheckbox.disabled = true;
  undoBtn.disabled      = true;
  restoreBtn.disabled   = true;
  hintText.textContent  = _browser.i18n.getMessage('pickHintRestricted');
  pickStatus.textContent = _browser.i18n.getMessage('pickStatusRestricted');
}

// ── Sites Data ────────────────────────────────────────────────────────────
async function loadSitesData() {
  try {
    const resp = await _browser.runtime.sendMessage({ action: 'getAllSitesData' });
    if (!resp) return;
    renderSites(resp.sites, resp.totalHidden);
  } catch (e) {
    renderSites([], 0);
  }
}

function renderSites(sites, totalHidden) {
  sitesTotalCount.textContent = totalHidden;
  clearAllSitesBtn.disabled = totalHidden === 0;

  // Update nav badge
  if (totalHidden > 0) {
    navSitesBadge.textContent = totalHidden;
    navSitesBadge.style.display = '';
  } else {
    navSitesBadge.textContent = '';
    navSitesBadge.style.display = 'none';
  }

  // Clear existing site items (keep the empty state element)
  const existingItems = sitesList.querySelectorAll('.site-item');
  existingItems.forEach(el => el.remove());

  if (sites.length === 0) {
    sitesEmpty.style.display = 'flex';
    return;
  }

  sitesEmpty.style.display = 'none';

  sites.forEach((site, index) => {
    const item = document.createElement('div');
    item.className = 'site-item';
    item.style.animationDelay = `${index * 0.04}s`;

    // Favicon
    const favicon = document.createElement('img');
    favicon.className = 'site-favicon';
    favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site.origin)}&sz=32`;
    favicon.alt = '';
    favicon.onerror = () => {
      favicon.style.display = 'none';
      const fallback = document.createElement('div');
      fallback.className = 'site-favicon-fallback';
      fallback.textContent = '🌐';
      item.insertBefore(fallback, item.firstChild);
    };

    // Info
    const info = document.createElement('div');
    info.className = 'site-info';

    const name = document.createElement('span');
    name.className = 'site-name';
    try {
      const u = new URL(site.origin);
      name.textContent = u.hostname;
    } catch {
      name.textContent = site.origin;
    }

    const count = document.createElement('span');
    count.className = 'site-count';
    const hiddenCountMsg = _browser.i18n.getMessage('siteHiddenCount', [String(site.count)]);
    count.textContent = hiddenCountMsg || `${site.count} hidden`;

    info.appendChild(name);
    info.appendChild(count);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'site-delete-btn';
    const clearSiteMsg = _browser.i18n.getMessage('clearSite', [name.textContent]) || `Clear ${name.textContent}`;
    deleteBtn.setAttribute('aria-label', clearSiteMsg);
    deleteBtn.setAttribute('title', clearSiteMsg);
    deleteBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="15" y1="5" x2="5" y2="15"/><line x1="5" y1="5" x2="15" y2="15"/></svg>`;
    deleteBtn.addEventListener('click', async () => {
      item.classList.add('removing');
      await _browser.runtime.sendMessage({ action: 'clearSiteData', origin: site.origin });
      setTimeout(() => loadSitesData(), 280);
    });

    item.appendChild(favicon);
    item.appendChild(info);
    item.appendChild(deleteBtn);
    sitesList.appendChild(item);
  });
}

clearAllSitesBtn.addEventListener('click', async () => {
  clearAllSitesBtn.disabled = true;
  await _browser.runtime.sendMessage({ action: 'clearAllSites' });
  // Refresh main view counts too
  try {
    const state = await _browser.runtime.sendMessage({ action: 'getHiddenElements' });
    if (state) {
      updateCount(state.count);
      updateButtons(state.count);
    }
  } catch (e) {}
  renderSites([], 0);
});

// ── Boot ──────────────────────────────────────────────────────────────────
init();
// Pre-load sites badge count
loadSitesData();
