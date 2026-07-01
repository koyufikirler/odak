/**
 * popup.js — Distraction Hider Popup Logic
 *
 * Communicates with background.js to:
 *  - Toggle Pick Mode on the active tab
 *  - Display hidden element count
 *  - Trigger Undo Last / Restore All via content script
 */

'use strict';

const _browser = typeof browser !== 'undefined' ? browser : chrome;

// ── DOM references ────────────────────────────────────────────────────────
const pickCheckbox    = document.getElementById('pick-mode-checkbox');
const pickCard        = document.getElementById('pick-mode-section');
const pickStatus      = document.getElementById('pick-mode-status');
const hintText        = document.getElementById('hint-text');
const hiddenCount     = document.getElementById('hidden-count');
const statusBadge     = document.getElementById('status-badge');
const badgeText       = document.getElementById('badge-text');
const undoBtn         = document.getElementById('undo-btn');
const restoreBtn      = document.getElementById('restore-btn');

// ── Initialize popup state ────────────────────────────────────────────────
async function init() {
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
    const resp = await _browser.tabs.sendMessage(tab.id, { action: 'undoLast' });

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
    badgeText.textContent = 'Active';
    pickStatus.textContent = 'Click any element to dissolve it';
    hintText.textContent = 'Hover to select • Click to dissolve • Esc to stop';
  } else {
    pickCard.classList.remove('active');
    statusBadge.classList.remove('active');
    badgeText.textContent = 'Inactive';
    pickStatus.textContent = 'Hover over elements to hide them';
    hintText.textContent = 'Click the toggle to start hiding distractions';
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
  hintText.textContent  = 'Not available on this page';
  pickStatus.textContent = 'Navigate to a regular webpage';
}

// ── Boot ──────────────────────────────────────────────────────────────────
init();
