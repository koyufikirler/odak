/**
 * panel.js — Control panel for ODAK.
 *
 * The panel is a thin, read-mostly view over storage. All blocking work still
 * happens inside the browser's declarativeNetRequest engine.
 */

'use strict';

const _browser = typeof browser !== 'undefined' ? browser : chrome;

const ADBLOCK_KEY = 'dh_adBlocking';
const PAUSED_KEY = 'dh_adBlockSites';
const FILTERS_KEY = 'dh_filterLists';
const STATS_RANGE_KEY = 'odak.statsRange';

const ICONS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="3" y1="12" x2="21" y2="12"></line><path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z"></path></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V5"></path><path d="M4 19h16"></path><path d="M8 15v-4"></path><path d="M12 15V8"></path><path d="M16 15v-6"></path></svg>',
};

const state = {
  enabled: true,
  pausedSites: [],
  filters: {},
  meta: null,
  query: '',
  stats: null,
  statsCurrent: null,
  statsDays: readStoredStatsRange(),
};

const UI_LANG = (() => {
  try {
    return String(_browser.i18n.getUILanguage() || navigator.language || '')
      .toLowerCase()
      .split(/[-_]/)[0];
  } catch (e) {
    return '';
  }
})();

const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames([UI_LANG || 'en'], { type: 'region' });
  } catch (e) {
    return null;
  }
})();

const LIST_FORMAT = (() => {
  try {
    return new Intl.ListFormat(UI_LANG || 'en', { style: 'long', type: 'conjunction' });
  } catch (e) {
    return null;
  }
})();

let metaPromise = null;

const els = {
  navItems: document.querySelectorAll('.nav-item'),
  tabs: document.querySelectorAll('.tab-panel'),
  pageTitle: document.getElementById('page-title'),
  statusPill: document.getElementById('status-pill'),
  statusText: document.getElementById('status-text'),
  masterToggle: document.getElementById('master-toggle'),
  protectionDesc: document.getElementById('protection-desc'),
  activeLists: document.getElementById('active-lists'),
  pausedCount: document.getElementById('paused-count'),
  pausedList: document.getElementById('paused-list'),
  resumeAll: document.getElementById('resume-all'),
  filterCategories: document.getElementById('filter-categories'),
  filtersSummary: document.getElementById('filters-summary'),
  filterSearch: document.getElementById('filter-search'),
  filtersEmpty: document.getElementById('filters-empty'),
  navFilterCount: document.getElementById('nav-filter-count'),
  statsTotal: document.getElementById('stats-total'),
  statsDays: document.getElementById('stats-days'),
  statsSites: document.getElementById('stats-sites'),
  statsSince: document.getElementById('stats-since'),
  statsRange: document.getElementById('stats-range'),
  statsRangeLabel: document.getElementById('stats-range-label'),
  statsChart: document.getElementById('stats-chart'),
  statsBars: document.getElementById('stats-bars'),
  statsAverage: document.getElementById('stats-average'),
  statsAxis: document.getElementById('stats-axis'),
  statsTooltip: document.getElementById('stats-tooltip'),
  statsChartEmpty: document.getElementById('stats-chart-empty'),
  statsChartEmptyTitle: document.getElementById('stats-chart-empty-title'),
  statsInsight: document.getElementById('stats-insight'),
  statsInsightText: document.getElementById('stats-insight-text'),
  statsPeriodTotal: document.getElementById('stats-period-total'),
  statsPeriodAverage: document.getElementById('stats-period-average'),
  statsBaselineNote: document.getElementById('stats-baseline-note'),
  statsSiteCount: document.getElementById('stats-site-count'),
  statsSiteList: document.getElementById('stats-site-list'),
  sidebarVersion: document.getElementById('sidebar-version'),
  aboutVersion: document.getElementById('about-version'),
};

// ── Helpers ───────────────────────────────────────────────────────────────

function message(key, fallback, substitutions) {
  let value = '';
  try {
    value = _browser.i18n.getMessage(key, substitutions) || '';
  } catch (e) {}
  if (!value) value = fallback;
  if (value && substitutions) {
    const list = Array.isArray(substitutions) ? substitutions : [substitutions];
    value = String(value).replace(/\$(\d+)/g, (_, index) => list[Number(index) - 1] ?? '');
  }
  return value;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const value = message(key, '');
    if (value) el.textContent = value;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const value = message(el.getAttribute('data-i18n-placeholder'), '');
    if (value) el.placeholder = value;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const value = message(el.getAttribute('data-i18n-aria-label'), '');
    if (value) el.setAttribute('aria-label', value);
  });
  document.title = `${message('panelTitle', 'Control Panel')} — ODAK`;
}

function formatNumber(value) {
  try {
    return new Intl.NumberFormat(UI_LANG || undefined).format(value);
  } catch (e) {
    return String(value);
  }
}

function listName(list) {
  return list.name || message(list.nameKey, list.id);
}

function isForUiLanguage(list) {
  return Boolean(UI_LANG) && Array.isArray(list.autoLangs) && list.autoLangs.includes(UI_LANG);
}

function regionName(code) {
  const value = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return value;
  try {
    return (REGION_NAMES && REGION_NAMES.of(value)) || value;
  } catch (e) {
    return value;
  }
}

function regionListText(langs) {
  const names = (Array.isArray(langs) ? langs : []).map(regionName).filter(Boolean);
  if (names.length === 0) return '';
  try {
    return LIST_FORMAT ? LIST_FORMAT.format(names) : names.join(', ');
  } catch (e) {
    return names.join(', ');
  }
}

function flagFor(code) {
  const value = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '';
  return String.fromCodePoint(
    0x1F1E6 + value.charCodeAt(0) - 65,
    0x1F1E6 + value.charCodeAt(1) - 65
  );
}

function listDescription(list) {
  if (list.descKey === 'filterRegionalDesc') {
    return message(
      'filterRegionalDesc',
      'Regional ad and tracker list for $1.',
      [regionListText(list.langs)]
    );
  }
  return message(list.descKey, '');
}

function listSearchText(list) {
  return [
    listName(list),
    list.id,
    list.category,
    listDescription(list),
    regionListText(list.langs),
    ...(Array.isArray(list.langs) ? list.langs : []),
    ...(Array.isArray(list.autoLangs) ? list.autoLangs : []),
  ].join(' ').toLowerCase();
}

// ── Statistics helpers ────────────────────────────────────────────────────

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The chart range is a view preference, not extension state. Keeping it in
// localStorage lets the panel reopen on the range the user last chose.
function readStoredStatsRange() {
  try {
    const value = Number(localStorage.getItem(STATS_RANGE_KEY));
    if ([7, 14, 30].includes(value)) return value;
  } catch (e) {}
  return 14;
}

function storeStatsRange(days) {
  try {
    localStorage.setItem(STATS_RANGE_KEY, String(days));
  } catch (e) {}
}

function parseDayKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function lastDayKeys(count) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const keys = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    keys.push(localDayKey(date));
  }
  return keys;
}

function formatStatDate(key) {
  try {
    return new Intl.DateTimeFormat(UI_LANG || undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(parseDayKey(key));
  } catch (e) {
    return String(key);
  }
}

function formatStatAverage(value) {
  try {
    return new Intl.NumberFormat(UI_LANG || undefined, {
      maximumFractionDigits: 1,
    }).format(value);
  } catch (e) {
    return String(Math.round(value * 10) / 10);
  }
}

function formatDayLabel(key, days) {
  try {
    const options = days > 7
      ? { month: 'short', day: 'numeric' }
      : { weekday: 'short' };
    return new Intl.DateTimeFormat(UI_LANG || undefined, options).format(parseDayKey(key));
  } catch (e) {
    return String(key);
  }
}

function formatTooltipDate(key) {
  if (key === localDayKey()) return message('statsToday', 'Today');
  try {
    return new Intl.DateTimeFormat(UI_LANG || undefined, {
      month: 'short',
      day: 'numeric',
    }).format(parseDayKey(key));
  } catch (e) {
    return formatStatDate(key);
  }
}

function activeDayCount(stats) {
  const days = new Set();
  for (const [key, value] of Object.entries(stats.daily || {})) {
    if (Number(value) > 0) days.add(key);
  }
  for (const [key, value] of Object.entries(stats.cleanedDaily || {})) {
    if (Number(value) > 0) days.add(key);
  }
  return days.size;
}

function statsDay(stats, key) {
  const hidden = Number(stats?.daily?.[key]) || 0;
  const cleaned = Number(stats?.cleanedDaily?.[key]) || 0;
  return { hidden, cleaned, total: hidden + cleaned };
}

function statsLifetimeTotal(stats) {
  return (Number(stats?.totalHidden) || 0) + (Number(stats?.totalCleaned) || 0);
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

function resolveFilters(meta, saved) {
  const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const resolved = {};
  for (const list of meta.lists) {
    if (typeof source[list.id] === 'boolean') {
      resolved[list.id] = source[list.id];
    } else {
      // Regional lists default to on only when they match the browser's UI
      // language. Once the user flips a switch, that explicit choice wins.
      resolved[list.id] = list.defaultEnabled === true || isForUiLanguage(list);
    }
  }
  return resolved;
}

function sameSites(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameFilters(saved, current) {
  if (!state.meta) return false;
  const next = resolveFilters(state.meta, saved);
  return Object.keys(next).every(id => next[id] === current[id]);
}

// The panel writes storage itself; skip the change event it echoes back so the
// focused switch is not torn down and rebuilt underneath the user.
function isLocalEcho(changes) {
  const masterEcho =
    !(ADBLOCK_KEY in changes) ||
    (changes[ADBLOCK_KEY].newValue !== false) === state.enabled;
  const pausedEcho =
    !(PAUSED_KEY in changes) ||
    sameSites(normalizePausedSites(changes[PAUSED_KEY].newValue), state.pausedSites);
  const filtersEcho =
    !(FILTERS_KEY in changes) ||
    sameFilters(changes[FILTERS_KEY].newValue, state.filters);
  return masterEcho && pausedEcho && filtersEcho;
}

// ── Data ──────────────────────────────────────────────────────────────────

async function loadMeta() {
  if (metaPromise) return metaPromise;

  metaPromise = (async () => {
    try {
      const response = await fetch(_browser.runtime.getURL('rules/lists.json'));
      if (!response.ok) throw new Error('Metadata unavailable');
      const data = await response.json();
      if (!Array.isArray(data.lists) || !Array.isArray(data.categories)) {
        throw new Error('Invalid metadata');
      }
      return data;
    } catch (e) {
      // The panel is still usable without the list catalogue.
      return { categories: [], lists: [] };
    }
  })();

  return metaPromise;
}

async function loadState() {
  const meta = await loadMeta();
  let stored = {};

  try {
    stored = await _browser.storage.local.get([ADBLOCK_KEY, PAUSED_KEY, FILTERS_KEY]);
  } catch (e) {
    stored = {};
  }

  state.meta = meta;
  state.enabled = stored[ADBLOCK_KEY] !== false;
  state.pausedSites = normalizePausedSites(stored[PAUSED_KEY]);
  state.filters = resolveFilters(meta, stored[FILTERS_KEY]);
  render();
}

function normalizePausedSites(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const sites = [];
  for (const value of list) {
    const host = normalizeHost(value);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    sites.push(host);
  }
  sites.sort((a, b) => a.localeCompare(b));
  return sites;
}

// ── Statistics data ───────────────────────────────────────────────────────

let statsPromise = null;

async function loadStats() {
  if (statsPromise) return statsPromise;

  statsPromise = (async () => {
    try {
      const response = await _browser.runtime.sendMessage({ action: 'getStatistics' });
      if (!response || !response.stats) throw new Error('Statistics unavailable');
      state.stats = response.stats;
      state.statsCurrent = response.current || { sites: [], totalHidden: 0 };
    } catch (e) {
      if (!state.stats) {
        state.stats = { version: 1, since: null, daily: {}, baseline: 0, totalHidden: 0 };
      }
      if (!state.statsCurrent) {
        state.statsCurrent = { sites: [], totalHidden: 0 };
      }
    }
    renderStats();
  })();

  try {
    await statsPromise;
  } finally {
    statsPromise = null;
  }
}

// ── Statistics rendering ──────────────────────────────────────────────────

function renderStats() {
  if (!state.stats) return;

  const stats = state.stats;
  const current = state.statsCurrent || { sites: [], totalHidden: 0 };
  const total = statsLifetimeTotal(stats);

  els.statsTotal.textContent = formatNumber(total);
  els.statsDays.textContent = formatNumber(activeDayCount(stats));
  els.statsSites.textContent = formatNumber((current.sites || []).length);

  if (stats.since && total > 0) {
    els.statsSince.hidden = false;
    els.statsSince.textContent = message('statsSince', 'Since $1', [formatStatDate(stats.since)]);
  } else {
    els.statsSince.hidden = true;
    els.statsSince.textContent = '';
  }

  renderStatsRangeControl();

  renderStatsChart();
  renderStatsSites(current.sites || []);
}

function renderStatsRangeControl() {
  if (!els.statsRange) return;

  els.statsRange.querySelectorAll('button[data-days]').forEach(button => {
    const days = Number(button.dataset.days);
    const active = days === state.statsDays;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.setAttribute('aria-label', message('statsRange', 'Last $1 days', [String(days)]));
  });
}

function renderStatsChart() {
  if (!state.stats) return;

  const count = state.statsDays;
  const keys = lastDayKeys(count);
  const days = keys.map(key => statsDay(state.stats, key));
  const values = days.map(day => day.total);
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(...values, 1) * 1.08;
  const today = localDayKey();
  const baseline = Number(state.stats.baseline) || 0;
  const hasPeriodActivity = total > 0;

  els.statsRangeLabel.textContent = message('statsRange', 'Last $1 days', [String(count)]);
  els.statsPeriodTotal.textContent = message('statsPeriodTotal', '$1 total', [formatNumber(total)]);
  els.statsPeriodAverage.textContent = message('statsDailyAverage', '$1 per day', [
    formatStatAverage(total / count),
  ]);

  if (baseline > 0) {
    els.statsBaselineNote.hidden = false;
    els.statsBaselineNote.textContent = message(
      'statsBaselineNote',
      '$1 elements were already hidden when tracking began.',
      [formatNumber(baseline)]
    );
  } else {
    els.statsBaselineNote.hidden = true;
    els.statsBaselineNote.textContent = '';
  }

  hideStatsTooltip();
  els.statsBars.textContent = '';
  els.statsBars.style.setProperty('--cols', String(count));
  els.statsChartEmpty.hidden = hasPeriodActivity;

  if (!hasPeriodActivity && els.statsChartEmptyTitle) {
    // Lifetime activity can exist while the selected window is empty; saying
    // "No activity yet" then would contradict the totals above the chart.
    const hasHistory = statsLifetimeTotal(state.stats) > 0;
    els.statsChartEmptyTitle.textContent = message(
      hasHistory ? 'statsNoActivityPeriod' : 'statsNoActivity',
      hasHistory ? 'No activity in this period' : 'No activity yet'
    );
  }

  const average = total / count;
  if (hasPeriodActivity && average > 0) {
    els.statsAverage.hidden = false;
    els.statsAverage.style.setProperty('--avg', String(Math.min(1, average / max)));
  } else {
    els.statsAverage.hidden = true;
    els.statsAverage.style.removeProperty('--avg');
  }

  renderStatsInsight(keys, total);

  keys.forEach((key, index) => {
    const day = days[index];
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'chart-bar';
    if (key === today) bar.classList.add('is-today');
    bar.dataset.day = key;
    bar.dataset.value = String(day.total);
    bar.tabIndex = index === keys.length - 1 ? 0 : -1;
    bar.setAttribute('aria-label', message(
      'statsBarAria',
      '$1 — $2 total ($3 hidden, $4 cleaned)',
      [formatStatDate(key), formatNumber(day.total), formatNumber(day.hidden), formatNumber(day.cleaned)]
    ));

    const track = document.createElement('span');
    track.className = 'chart-bar-track';

    const stack = document.createElement('span');
    stack.className = 'chart-bar-stack';
    stack.style.height = day.total > 0
      ? `${Math.max(3, (day.total / max) * 100)}%`
      : '0%';
    stack.style.setProperty('--i', String(index));

    const segments = [];
    if (day.hidden > 0) segments.push(['is-hidden', day.hidden]);
    if (day.cleaned > 0) segments.push(['is-cleaned', day.cleaned]);

    segments.forEach(([className, value]) => {
      const segment = document.createElement('span');
      segment.className = `chart-bar-seg ${className}`;
      segment.style.height = `${(value / day.total) * 100}%`;
      stack.appendChild(segment);
    });

    track.appendChild(stack);
    bar.appendChild(track);

    bar.addEventListener('pointerenter', () => showStatsTooltip(bar, key, day));
    bar.addEventListener('focus', () => {
      statsBarElements().forEach(el => {
        el.tabIndex = el === bar ? 0 : -1;
      });
      showStatsTooltip(bar, key, day);
    });
    bar.addEventListener('pointerleave', hideStatsTooltip);
    bar.addEventListener('blur', hideStatsTooltip);

    els.statsBars.appendChild(bar);
  });

  els.statsAxis.textContent = '';
  els.statsAxis.style.setProperty('--cols', String(count));
  keys.forEach((key, index) => {
    const label = document.createElement('span');
    label.className = 'chart-axis-label';
    const visible = count <= 7
      ? true
      : count <= 14
        ? (index % 2 === 1 || index === count - 1)
        : (index % 5 === 0 || index === count - 1);
    if (!visible) label.classList.add('is-hidden');
    label.textContent = key === today
      ? message('statsToday', 'Today')
      : formatDayLabel(key, count);
    els.statsAxis.appendChild(label);
  });
}

function renderStatsInsight(keys, total) {
  if (!els.statsInsight || !els.statsInsightText) return;

  const insight = statsPeriodInsight(keys, total);
  if (!insight) {
    els.statsInsight.hidden = true;
    els.statsInsightText.textContent = '';
    els.statsInsight.classList.remove('is-down', 'is-same');
    return;
  }

  els.statsInsight.hidden = false;
  els.statsInsight.classList.toggle('is-down', insight.direction === 'down');
  els.statsInsight.classList.toggle('is-same', insight.direction === 'same');
  els.statsInsightText.textContent = insight.text;
}

function statsPeriodInsight(keys, total) {
  if (!state.stats || total <= 0) return null;

  const count = keys.length;
  const since = state.stats.since;
  const previousKeys = lastDayKeys(count * 2).slice(0, count);

  // Only compare fully tracked windows, and never include the day tracking
  // began: it carries the pre-existing baseline and would distort the result.
  if (!since || previousKeys[0] <= since) return null;

  const previousTotal = previousKeys.reduce(
    (sum, key) => sum + statsDay(state.stats, key).total,
    0
  );
  if (previousTotal <= 0) return null;

  const change = ((total - previousTotal) / previousTotal) * 100;
  const percent = Math.round(Math.abs(change));

  if (percent === 0) {
    return {
      direction: 'same',
      text: message('statsInsightSame', 'About the same as the previous $1 days', [String(count)]),
    };
  }

  if (change > 0) {
    return {
      direction: 'up',
      text: message('statsInsightMore', '$1% more than the previous $2 days', [
        formatNumber(percent),
        String(count),
      ]),
    };
  }

  return {
    direction: 'down',
    text: message('statsInsightFewer', '$1% fewer than the previous $2 days', [
      formatNumber(percent),
      String(count),
    ]),
  };
}

function statsBarElements() {
  return Array.from(els.statsBars.querySelectorAll('.chart-bar'));
}

function focusStatsBar(index) {
  const bars = statsBarElements();
  if (bars.length === 0) return;
  const target = Math.max(0, Math.min(bars.length - 1, index));
  bars.forEach((bar, i) => {
    bar.tabIndex = i === target ? 0 : -1;
  });
  bars[target].focus();
}

function showStatsTooltip(bar, key, day) {
  if (!els.statsTooltip || !els.statsChart) return;

  const plotRect = els.statsChart.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  if (!plotRect.width || !barRect.width) return;

  const center = barRect.left - plotRect.left + barRect.width / 2;
  const stack = bar.querySelector('.chart-bar-stack');
  const stackHeight = stack ? stack.getBoundingClientRect().height : 0;
  const top = Math.max(34, plotRect.height - stackHeight - 8);

  els.statsTooltip.textContent = '';

  const totalLine = document.createElement('span');
  totalLine.className = 'chart-tooltip-total';
  totalLine.textContent = `${formatTooltipDate(key)} · ${formatNumber(day.total)}`;
  els.statsTooltip.appendChild(totalLine);

  if (day.hidden > 0 && day.cleaned > 0) {
    const split = document.createElement('span');
    split.className = 'chart-tooltip-split';
    split.textContent = `${formatNumber(day.hidden)} ${message('statsSeriesHidden', 'Hidden by you')} · ${formatNumber(day.cleaned)} ${message('statsSeriesCleaned', 'Cleaned automatically')}`;
    els.statsTooltip.appendChild(split);
  }

  els.statsTooltip.style.left = '0px';
  els.statsTooltip.hidden = false;

  // Measure the real tooltip so longer localized dates still stay inside the
  // plot instead of relying on a fixed guess.
  const tooltipWidth = els.statsTooltip.getBoundingClientRect().width;
  const half = Math.min(tooltipWidth / 2 + 4, plotRect.width / 2);
  const left = Math.min(Math.max(center, half), plotRect.width - half);

  els.statsTooltip.style.left = `${left}px`;
  els.statsTooltip.style.top = `${top}px`;
}

function hideStatsTooltip() {
  if (els.statsTooltip) els.statsTooltip.hidden = true;
}

function renderStatsSites(sites) {
  els.statsSiteList.textContent = '';
  const siteTotal = sites.reduce((sum, site) => sum + (Number(site.count) || 0), 0);
  els.statsSiteCount.textContent = siteTotal > 0
    ? message('siteHiddenCount', '$1 hidden', [formatNumber(siteTotal)])
    : '';

  const top = sites.slice(0, 5);
  if (top.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';

    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.innerHTML = ICONS.chart;

    const text = document.createElement('p');
    text.textContent = message('statsNoSites', 'No hidden elements yet');

    empty.append(icon, text);
    els.statsSiteList.appendChild(empty);
    return;
  }

  const max = top[0].count || 1;
  for (const site of top) {
    const row = document.createElement('div');
    row.className = 'row stat-site-row';

    const copy = document.createElement('div');
    copy.className = 'row-copy';

    const title = document.createElement('h3');
    title.className = 'row-title stat-site-title';

    const name = document.createElement('span');
    name.className = 'stat-site-name';
    name.textContent = String(site.origin || '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');

    const count = document.createElement('span');
    count.className = 'stat-site-count';
    count.textContent = formatNumber(site.count || 0);

    title.append(name, count);

    const track = document.createElement('span');
    track.className = 'stat-site-track';

    const fill = document.createElement('span');
    fill.className = 'stat-site-fill';
    fill.style.width = `${Math.max(6, ((site.count || 0) / max) * 100)}%`;
    track.appendChild(fill);

    copy.append(title, track);
    row.appendChild(copy);
    els.statsSiteList.appendChild(row);
  }
}

function setStatsRange(days) {
  const value = [7, 14, 30].includes(days) ? days : 14;
  if (state.statsDays === value) return;
  state.statsDays = value;
  storeStatsRange(value);
  renderStatsChart();
  renderStatsRangeControl();
}

// ── Rendering ─────────────────────────────────────────────────────────────

function render() {
  if (!state.meta) return;

  renderStatus();
  renderMetrics();
  renderPausedSites();
  renderFilters();
}

function renderStatus() {
  const on = state.enabled;

  els.statusPill.classList.toggle('off', !on);
  els.statusText.textContent = on
    ? message('panelOn', 'Protection on')
    : message('panelOff', 'Protection off');
  els.masterToggle.checked = on;
  els.protectionDesc.textContent = on
    ? message('panelProtectionDesc', 'Blocks ads and trackers across every site.')
    : message('adblockInactive', 'Off — ads and trackers are allowed');
}

function renderMetrics() {
  const total = state.meta.lists.length;
  const enabled = state.enabled ? enabledLists().length : 0;
  els.activeLists.textContent = `${enabled}/${total}`;
  els.pausedCount.textContent = String(state.pausedSites.length);
  els.navFilterCount.textContent = String(total);
}

function enabledLists() {
  return state.meta.lists.filter(list => Boolean(state.filters[list.id]));
}

function renderPausedSites() {
  els.pausedList.textContent = '';
  const sites = state.pausedSites;
  els.resumeAll.hidden = sites.length === 0;

  if (sites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';

    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.innerHTML = ICONS.check;

    const text = document.createElement('p');
    text.textContent = message('panelNoPaused', 'No paused sites');

    empty.append(icon, text);
    els.pausedList.appendChild(empty);
    return;
  }

  for (const site of sites) {
    const row = document.createElement('div');
    row.className = 'row';

    const icon = document.createElement('span');
    icon.className = 'host-icon';
    icon.innerHTML = ICONS.globe;

    const name = document.createElement('span');
    name.className = 'host-name';
    name.textContent = site;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill-btn';
    button.dataset.site = site;
    button.textContent = message('panelResume', 'Resume');

    row.append(icon, name, button);
    els.pausedList.appendChild(row);
  }
}

function renderFilters() {
  const meta = state.meta;
  const enabled = enabledLists();
  const domains = enabled.reduce((sum, list) => sum + (list.domainCount || 0), 0);
  const query = state.query.trim().toLowerCase();

  els.filtersSummary.textContent = message(
    'panelFiltersSummary',
    '$1 of $2 lists · $3 domains',
    [String(enabled.length), String(meta.lists.length), formatNumber(domains)]
  );

  els.filterCategories.textContent = '';
  let shownLists = 0;

  for (const category of meta.categories) {
    // Language-matched regional lists float to the top of their group, while
    // the relative order of everything else stays as authored.
    const lists = meta.lists
      .filter(list => list.category === category.id)
      .sort((a, b) => Number(isForUiLanguage(b)) - Number(isForUiLanguage(a)));
    if (lists.length === 0) continue;

    const visible = query
      ? lists.filter(list => listSearchText(list).includes(query))
      : lists;
    if (visible.length === 0) continue;

    const enabledInCategory = lists.filter(list => state.filters[list.id]).length;
    shownLists += visible.length;

    const section = document.createElement('section');
    section.className = 'filter-group';

    const head = document.createElement('div');
    head.className = 'filter-group-head';

    const title = document.createElement('h2');
    title.textContent = message(category.nameKey, category.id);

    const count = document.createElement('span');
    count.className = 'filter-count';
    count.textContent = `${enabledInCategory}/${lists.length}`;

    head.append(title, count);

    const card = document.createElement('div');
    card.className = 'group-card';

    for (const list of visible) {
      card.appendChild(renderFilterRow(list));
    }

    section.append(head, card);
    els.filterCategories.appendChild(section);
  }

  if (els.filtersEmpty) {
    els.filtersEmpty.hidden = shownLists > 0 || query === '';
  }
}

function renderFilterRow(list) {
  const row = document.createElement('div');
  row.className = 'row';

  const copy = document.createElement('div');
  copy.className = 'row-copy';

  const title = document.createElement('h3');
  title.className = 'row-title';

  const langs = Array.isArray(list.langs) ? list.langs : [];
  if (langs.length > 0) {
    const flags = document.createElement('span');
    flags.className = 'row-flags';
    flags.title = regionListText(langs);
    flags.setAttribute('aria-hidden', 'true');
    for (const code of langs) {
      const flag = document.createElement('span');
      flag.className = 'row-flag';
      flag.textContent = flagFor(code) || String(code).toUpperCase();
      flags.appendChild(flag);
    }
    title.appendChild(flags);
  }

  const name = document.createElement('span');
  name.textContent = listName(list);
  title.appendChild(name);

  const forLanguage = isForUiLanguage(list);
  if (list.recommended || forLanguage) {
    const pill = document.createElement('span');
    pill.className = forLanguage ? 'pill lang' : 'pill';
    pill.textContent = list.recommended
      ? message('panelRecommended', 'Recommended')
      : message('panelForYourLanguage', 'For your language');
    title.appendChild(pill);
  }

  const desc = document.createElement('p');
  desc.className = 'row-desc';
  desc.textContent = listDescription(list);

  const meta = document.createElement('p');
  meta.className = 'row-meta';
  const metaParts = [];
  if (typeof list.ruleCount === 'number') {
    metaParts.push(message('panelRules', '$1 rules', [formatNumber(list.ruleCount)]));
  }
  metaParts.push(message('panelDomains', '$1 domains', [formatNumber(list.domainCount || 0)]));
  meta.textContent = metaParts.join(' · ');

  copy.append(title, desc, meta);

  const switchWrap = document.createElement('label');
  switchWrap.className = 'switch small';
  switchWrap.setAttribute('aria-label', name.textContent);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(state.filters[list.id]);
  input.dataset.listId = list.id;

  const track = document.createElement('span');
  track.className = 'switch-track';

  switchWrap.append(input, track);
  row.append(copy, switchWrap);
  return row;
}

// ── Actions ───────────────────────────────────────────────────────────────

async function saveFilters() {
  try {
    await _browser.storage.local.set({ [FILTERS_KEY]: { ...state.filters } });
  } catch (e) {}
}

async function savePausedSites() {
  try {
    await _browser.storage.local.set({ [PAUSED_KEY]: state.pausedSites });
  } catch (e) {}
}

async function setEnabled(enabled) {
  state.enabled = enabled;
  renderStatus();
  renderMetrics();
  try {
    await _browser.storage.local.set({ [ADBLOCK_KEY]: enabled });
  } catch (e) {}
}

// ── Events ────────────────────────────────────────────────────────────────

function setupEvents() {
  els.masterToggle.addEventListener('change', () => {
    setEnabled(els.masterToggle.checked);
  });

  els.filterSearch?.addEventListener('input', () => {
    state.query = els.filterSearch.value;
    renderFilters();
  });

  els.statsRange?.addEventListener('click', event => {
    const button = event.target.closest('button[data-days]');
    if (!button) return;
    setStatsRange(Number(button.dataset.days));
  });

  els.statsBars?.addEventListener('keydown', event => {
    const bars = statsBarElements();
    const index = bars.indexOf(document.activeElement);
    if (index === -1) return;

    let next = null;
    if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = bars.length - 1;
    if (next == null) return;

    event.preventDefault();
    focusStatsBar(next);
  });

  els.filterCategories.addEventListener('change', event => {
    const input = event.target.closest('input[data-list-id]');
    if (!input) return;
    const id = input.dataset.listId;
    if (!(id in state.filters)) return;
    state.filters = { ...state.filters, [id]: input.checked };
    saveFilters();
    renderMetrics();
    renderFilters();
    const next = document.querySelector(`input[data-list-id="${id}"]`);
    if (next) next.focus();
  });

  els.pausedList.addEventListener('click', event => {
    const button = event.target.closest('button[data-site]');
    if (!button) return;
    const site = button.dataset.site;
    state.pausedSites = state.pausedSites.filter(value => value !== site);
    savePausedSites();
    renderPausedSites();
    renderMetrics();
  });

  els.resumeAll.addEventListener('click', () => {
    state.pausedSites = [];
    savePausedSites();
    renderPausedSites();
    renderMetrics();
  });

  els.navItems.forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  window.addEventListener('hashchange', () => {
    switchTab(currentHashTab(), false);
  });

  try {
    _browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      const statsChanged = Object.keys(changes).some(key =>
        key === 'dh_stats' ||
        key.startsWith('dh_site:') ||
        key.startsWith('http://') ||
        key.startsWith('https://')
      );
      if (statsChanged) loadStats();

      if (!changes[ADBLOCK_KEY] && !changes[PAUSED_KEY] && !changes[FILTERS_KEY]) return;
      if (isLocalEcho(changes)) return;
      loadState();
    });
  } catch (e) {}
}

// ── Tabs ──────────────────────────────────────────────────────────────────

const TAB_TITLE_KEYS = {
  general: ['panelGeneral', 'General'],
  stats: ['panelStatistics', 'Statistics'],
  filters: ['panelFilters', 'Filters'],
  about: ['panelAbout', 'About'],
};

function currentHashTab() {
  const id = (window.location.hash || '').replace(/^#/, '');
  return TAB_TITLE_KEYS[id] ? id : 'general';
}

function switchTab(tab, updateHash = true) {
  const target = TAB_TITLE_KEYS[tab] ? tab : 'general';

  els.tabs.forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${target}`);
  });

  els.navItems.forEach(item => {
    const active = item.dataset.tab === target;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  const [key, fallback] = TAB_TITLE_KEYS[target];
  els.pageTitle.textContent = message(key, fallback);

  if (target === 'stats') {
    if (state.stats) renderStats();
    loadStats();
  }

  if (updateHash && window.location.hash !== `#${target}`) {
    history.replaceState(null, '', `#${target}`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  applyI18n();
  setupEvents();

  try {
    const version = _browser.runtime.getManifest().version;
    if (els.sidebarVersion) els.sidebarVersion.textContent = `ODAK v${version}`;
    if (els.aboutVersion) els.aboutVersion.textContent = version;
  } catch (e) {}

  await loadState();
  switchTab(currentHashTab(), false);
  loadStats();
}

boot();
