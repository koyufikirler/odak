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

// ── Ad blocking ─────────────────────────────────────────────────────────────
// The heavy lifting happens inside the browser's declarativeNetRequest engine.
// This worker only mirrors the setting into the enabled ruleset and maintains
// one allow rule per site the user has paused — nothing runs per request.
const ADBLOCK_KEY = 'dh_adBlocking';
const ADBLOCK_PAUSED_KEY = 'dh_adBlockSites';
const ADBLOCK_FILTERS_KEY = 'dh_filterLists';
const ADBLOCK_REMOTE_META_KEY = 'dh_remoteFilterMeta';
const ADBLOCK_REMOTE_RULES_PREFIX = 'dh_remoteFilterRules_';
const ADBLOCK_REMOTE_TTL_MS = 24 * 60 * 60 * 1000;
const ADBLOCK_ALLOW_RULE_BASE = 10000;
const ADBLOCK_MAX_PAUSED_SITES = 100;
const ADBLOCK_REMOTE_RULE_BASE = 20000;

// Used only when rules/lists.json cannot be read. The catalogue is the source
// of truth: it carries the core lists plus the 38 regional rulesets.
const ADBLOCK_FALLBACK_LISTS = [
  { id: 'ads', defaultEnabled: true, autoLangs: [] },
  { id: 'privacy', defaultEnabled: true, autoLangs: [] },
  { id: 'mobile', defaultEnabled: true, autoLangs: [] },
  { id: 'risky', defaultEnabled: true, autoLangs: [] },
];

const STATS_KEY = 'dh_stats';
const STATS_VERSION = 2;
const STATS_MAX_DAYS = 400;

let adBlockListsPromise = null;

function loadAdBlockLists() {
  if (adBlockListsPromise) return adBlockListsPromise;

  adBlockListsPromise = (async () => {
    try {
      const response = await fetch(_browser.runtime.getURL('rules/lists.json'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.lists) || data.lists.length === 0) {
        throw new Error('Invalid list catalogue');
      }
      return data.lists
        .filter(list => list && typeof list.id === 'string')
        .map(list => ({
          id: list.id,
          defaultEnabled: list.defaultEnabled === true,
          autoLangs: Array.isArray(list.autoLangs) ? list.autoLangs : [],
          remoteUrl: typeof list.remoteUrl === 'string' && list.remoteUrl ? list.remoteUrl : null,
        }));
    } catch (e) {
      return ADBLOCK_FALLBACK_LISTS;
    }
  })();

  return adBlockListsPromise;
}

function getUiLanguage() {
  try {
    return String(_browser.i18n.getUILanguage() || '').toLowerCase().split(/[-_]/)[0];
  } catch (e) {
    return '';
  }
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

function normalizePausedSites(list) {
  if (!Array.isArray(list)) return [];
  const sites = [];
  for (const value of list) {
    const host = normalizeHost(value);
    if (!host || sites.includes(host)) continue;
    sites.push(host);
    if (sites.length >= ADBLOCK_MAX_PAUSED_SITES) break;
  }
  return sites;
}

async function resolveFilterLists(saved) {
  const lists = await loadAdBlockLists();
  const map = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const language = getUiLanguage();
  const resolved = {};

  for (const list of lists) {
    if (typeof map[list.id] === 'boolean') {
      resolved[list.id] = map[list.id];
    } else {
      // Regional lists are off unless they match the browser's UI language;
      // an explicit choice in the panel always wins.
      resolved[list.id] = list.defaultEnabled ||
        (language !== '' && list.autoLangs.includes(language));
    }
  }

  return resolved;
}

async function getAdBlockState() {
  const data = await _browser.storage.local
    .get([ADBLOCK_KEY, ADBLOCK_PAUSED_KEY, ADBLOCK_FILTERS_KEY])
    .catch(() => ({}));
  return {
    enabled: data[ADBLOCK_KEY] !== false,
    pausedSites: normalizePausedSites(data[ADBLOCK_PAUSED_KEY]),
    filters: await resolveFilterLists(data[ADBLOCK_FILTERS_KEY]),
  };
}

// ── Remote ABP filter parser (EasyList) ─────────────────────────────────────
const REMOTE_ALL_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

const REMOTE_TYPE_MAP = {
  image: 'image',
  media: 'media',
  script: 'script',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  font: 'font',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  other: 'other',
};

const REMOTE_SKIP_OPTIONS = new Set([
  'redirect', 'redirect-rule', 'csp', 'removeparam', 'replace', 'rewrite',
  'empty', 'mp4', 'inline-script', 'inline-font', 'webrtc', 'cookie',
  'permissions', 'urltransform', 'method', 'header', 'badfilter',
  'generichide', 'elemhide', 'specifichide', 'genericblock', 'document',
  'doc', 'popup', 'popunder', 'match-case', 'sitekey', 'denyallow', 'to',
  'from', 'all',
]);

const REMOTE_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const REMOTE_DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const REMOTE_ASCII_RE = /^[\x20-\x7e]+$/;
const REMOTE_DOMAINS_PER_RULE = 200;

function toAsciiHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return null;
  if (REMOTE_DOMAIN_RE.test(host)) return host;
  try {
    const ascii = new URL(`http://${host}`).hostname;
    if (ascii && REMOTE_DOMAIN_RE.test(ascii)) return ascii;
  } catch (e) {}
  return null;
}

function cleanRemoteDomains(values) {
  const result = [];
  for (const value of values) {
    const ascii = toAsciiHost(value.replace(/^\*\./, ''));
    if (ascii && !result.includes(ascii)) result.push(ascii);
  }
  return result;
}

function parseRemoteOptions(raw) {
  const opts = {
    types: [],
    negTypes: [],
    initiators: [],
    excludedInitiators: [],
    thirdParty: false,
    firstParty: false,
    important: false,
  };
  if (!raw) return opts;

  for (const piece of raw.split(',')) {
    if (!piece) return null;
    let name = piece;
    let neg = false;
    if (name.startsWith('~')) {
      neg = true;
      name = name.slice(1);
    }
    const eq = name.indexOf('=');
    const key = (eq === -1 ? name : name.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : name.slice(eq + 1);

    if (key === 'third-party' || key === '3p') {
      if (neg) opts.firstParty = true;
      else opts.thirdParty = true;
      continue;
    }
    if (key === 'first-party' || key === '1p') {
      if (neg) opts.thirdParty = true;
      else opts.firstParty = true;
      continue;
    }
    if (key === 'domain') {
      for (const domain of value.split('|')) {
        if (!domain) continue;
        if (domain.startsWith('~')) opts.excludedInitiators.push(domain.slice(1));
        else opts.initiators.push(domain);
      }
      continue;
    }
    if (key === 'important') {
      opts.important = true;
      continue;
    }
    if (REMOTE_SKIP_OPTIONS.has(key)) return null;
    if (REMOTE_TYPE_MAP[key]) {
      if (neg) opts.negTypes.push(REMOTE_TYPE_MAP[key]);
      else opts.types.push(REMOTE_TYPE_MAP[key]);
      continue;
    }
    return null;
  }

  return opts;
}

function convertRemoteLine(line, isException, bareHost) {
  let body = isException ? line.slice(2) : line;
  body = body.trim();
  if (!body) return null;
  if (body.startsWith('/') && body.endsWith('/')) return null;
  if (body.includes('##') || body.includes('#@#') || body.includes('#$#') || body.includes('#%#') || body.includes('#?#')) return null;

  let pattern = body;
  let optionsRaw = '';
  const dollar = body.lastIndexOf('$');
  if (dollar !== -1) {
    pattern = body.slice(0, dollar);
    optionsRaw = body.slice(dollar + 1);
  }
  if (!pattern) return null;
  if (/[\s\x00-\x1f]/.test(pattern)) return null;

  const opts = parseRemoteOptions(optionsRaw);
  if (!opts) return null;

  const condition = {};
  const effectivePattern = bareHost ? `||${pattern}^` : pattern;

  const exactHost = effectivePattern.match(/^\|\|([^/*|^]+)\^$/);
  if (exactHost) {
    const ascii = toAsciiHost(exactHost[1]);
    if (ascii) condition.requestDomains = [ascii];
  }

  if (!condition.requestDomains) {
    if (!REMOTE_ASCII_RE.test(effectivePattern)) return null;
    if (effectivePattern.startsWith('||*')) return null;
    if (effectivePattern.indexOf('||', 2) !== -1) return null;
    if (effectivePattern.length > 200) return null;
    condition.urlFilter = effectivePattern;
  }

  if (opts.thirdParty && !opts.firstParty) condition.domainType = 'thirdParty';
  if (opts.firstParty && !opts.thirdParty) condition.domainType = 'firstParty';

  const initiators = cleanRemoteDomains(opts.initiators);
  const excluded = cleanRemoteDomains(opts.excludedInitiators);
  if (initiators.length) condition.initiatorDomains = initiators;
  if (excluded.length) condition.excludedInitiatorDomains = excluded;
  if (opts.initiators.length && initiators.length === 0) return null;
  if (opts.excludedInitiators.length && excluded.length === 0) return null;

  if (opts.types.length) {
    condition.resourceTypes = [...new Set(opts.types)];
  } else if (opts.negTypes.length) {
    condition.resourceTypes = REMOTE_ALL_TYPES.filter(type => !opts.negTypes.includes(type));
    if (condition.resourceTypes.length === 0) return null;
  }

  return {
    priority: isException ? 3 : opts.important ? 4 : 1,
    action: { type: isException ? 'allow' : 'block' },
    condition,
  };
}

function buildRemoteDnrRules(text, maxRules) {
  const groups = new Map();
  const urlRules = [];
  const seenUrl = new Set();

  for (const rawLine of String(text || '').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) continue;

    const isException = line.startsWith('@@');
    if (isException) line = line.slice(2).trim();

    const bareHost = !isException && !line.startsWith('|') && !line.startsWith('.') && REMOTE_HOST_RE.test(line) && line.includes('.');
    const rule = convertRemoteLine(isException ? `@@${line}` : line, isException, bareHost);
    if (!rule) continue;

    if (rule.condition.requestDomains) {
      const { requestDomains, ...rest } = rule.condition;
      const key = JSON.stringify([rule.priority, rule.action.type, rest]);
      if (!groups.has(key)) groups.set(key, { rule, domains: new Set() });
      for (const domain of requestDomains) groups.get(key).domains.add(domain);
    } else {
      const key = JSON.stringify(rule);
      if (seenUrl.has(key)) continue;
      seenUrl.add(key);
      urlRules.push(rule);
    }
  }

  const rules = [];
  for (const { rule, domains } of groups.values()) {
    const list = [...domains].sort();
    for (let i = 0; i < list.length; i += REMOTE_DOMAINS_PER_RULE) {
      if (rules.length >= maxRules) break;
      const chunk = list.slice(i, i + REMOTE_DOMAINS_PER_RULE);
      rules.push({
        priority: rule.priority,
        action: rule.action,
        condition: { ...rule.condition, requestDomains: chunk },
      });
    }
    if (rules.length >= maxRules) break;
  }

  for (const rule of urlRules) {
    if (rules.length >= maxRules) break;
    rules.push(rule);
  }

  const uniqueDomains = new Set();
  for (const rule of rules) {
    for (const domain of rule.condition?.requestDomains || []) {
      uniqueDomains.add(domain);
    }
  }

  return { rules, domainCount: uniqueDomains.size };
}

async function setRemoteMetaEntry(listId, entry) {
  const stored = await _browser.storage.local.get(ADBLOCK_REMOTE_META_KEY).catch(() => ({}));
  const current = stored[ADBLOCK_REMOTE_META_KEY] && typeof stored[ADBLOCK_REMOTE_META_KEY] === 'object'
    ? stored[ADBLOCK_REMOTE_META_KEY]
    : {};
  const next = { ...current, [listId]: entry };
  await _browser.storage.local.set({ [ADBLOCK_REMOTE_META_KEY]: next }).catch(() => {});
}

async function syncRemoteFilters(api, { enabled, filters, lists, existingDynamicRules, forceIds = new Set() }) {
  const remoteLists = lists.filter(list => Boolean(list.remoteUrl));
  if (remoteLists.length === 0) return;

  const existingRemoteIds = existingDynamicRules
    .filter(rule => rule.id >= ADBLOCK_REMOTE_RULE_BASE)
    .map(rule => rule.id);

  const activeLists = enabled ? remoteLists.filter(list => filters[list.id]) : [];
  if (activeLists.length === 0) {
    if (existingRemoteIds.length > 0) {
      await api.updateDynamicRules({ removeRuleIds: existingRemoteIds, addRules: [] });
    }
    return;
  }

  const maxDynamic = api.MAX_NUMBER_OF_DYNAMIC_RULES || api.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || 5000;
  const budget = Math.max(0, maxDynamic - ADBLOCK_MAX_PAUSED_SITES);
  const perListBudget = Math.floor(budget / activeLists.length);
  const metaStored = await _browser.storage.local.get(ADBLOCK_REMOTE_META_KEY).catch(() => ({}));
  const metaMap = metaStored[ADBLOCK_REMOTE_META_KEY] && typeof metaStored[ADBLOCK_REMOTE_META_KEY] === 'object'
    ? metaStored[ADBLOCK_REMOTE_META_KEY]
    : {};

  const combinedRules = [];
  let needsDnrUpdate = existingRemoteIds.length === 0 || forceIds.size > 0;

  for (const list of activeLists) {
    const cacheKey = `${ADBLOCK_REMOTE_RULES_PREFIX}${list.id}`;
    const cachedStored = await _browser.storage.local.get(cacheKey).catch(() => ({}));
    const cached = cachedStored[cacheKey];
    const isFresh =
      cached &&
      cached.url === list.remoteUrl &&
      Array.isArray(cached.rules) &&
      typeof cached.updatedAt === 'number' &&
      Date.now() - cached.updatedAt < ADBLOCK_REMOTE_TTL_MS &&
      !forceIds.has(list.id);

    if (isFresh) {
      combinedRules.push(...cached.rules);
      continue;
    }

    needsDnrUpdate = true;
    const prevMeta = metaMap[list.id] || {};
    await setRemoteMetaEntry(list.id, {
      ...prevMeta,
      url: list.remoteUrl,
      status: 'loading',
      error: null,
    });

    try {
      const response = await fetch(list.remoteUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const { rules, domainCount } = buildRemoteDnrRules(text, perListBudget);
      const updatedAt = Date.now();

      await _browser.storage.local.set({
        [cacheKey]: { url: list.remoteUrl, updatedAt, rules },
      }).catch(() => {});

      await setRemoteMetaEntry(list.id, {
        url: list.remoteUrl,
        updatedAt,
        ruleCount: rules.length,
        domainCount,
        status: 'ready',
        error: null,
      });

      combinedRules.push(...rules);
    } catch (err) {
      await setRemoteMetaEntry(list.id, {
        ...prevMeta,
        url: list.remoteUrl,
        status: 'error',
        error: err?.message || 'Failed to fetch list',
      });

      if (cached && Array.isArray(cached.rules)) {
        combinedRules.push(...cached.rules);
      }
    }
  }

  if (!needsDnrUpdate && existingRemoteIds.length === combinedRules.length) {
    return;
  }

  const addRules = combinedRules.slice(0, budget).map((rule, index) => ({
    ...rule,
    id: ADBLOCK_REMOTE_RULE_BASE + index,
  }));

  try {
    await api.updateDynamicRules({
      removeRuleIds: existingRemoteIds,
      addRules,
    });
  } catch (err) {
    for (const list of activeLists) {
      const prevMeta = metaMap[list.id] || {};
      await setRemoteMetaEntry(list.id, {
        ...prevMeta,
        url: list.remoteUrl,
        status: 'error',
        error: err?.message || 'Failed to apply rules',
      });
    }
  }
}

async function syncAdBlockState(options = {}) {
  const api = _browser.declarativeNetRequest;
  if (!api) return;
  const { enabled, pausedSites, filters } = await getAdBlockState();
  const lists = await loadAdBlockLists();
  const staticLists = lists.filter(list => !list.remoteUrl);
  const validStaticIds = new Set(staticLists.map(list => list.id));

  const enableRulesetIds = new Set();
  const disableRulesetIds = new Set();

  for (const list of staticLists) {
    if (enabled && filters[list.id]) enableRulesetIds.add(list.id);
    else disableRulesetIds.add(list.id);
  }

  // Retire rulesets that disappeared from the catalogue (for example the old
  // single "turkiye" list) so they cannot linger enabled.
  try {
    const current = await api.getEnabledRulesets();
    for (const id of current) {
      if (!validStaticIds.has(id)) disableRulesetIds.add(id);
    }
  } catch (e) {}

  for (const id of enableRulesetIds) disableRulesetIds.delete(id);

  try {
    await api.updateEnabledRulesets({
      enableRulesetIds: [...enableRulesetIds],
      disableRulesetIds: [...disableRulesetIds],
    });
  } catch (e) {}

  let existingDynamicRules = [];
  try {
    existingDynamicRules = await api.getDynamicRules();
    // `allowAllRequests` on the main frame covers every subresource in the
    // page, so one low-maintenance rule per paused site is enough.
    const removeRuleIds = existingDynamicRules
      .filter(rule => rule.id >= ADBLOCK_ALLOW_RULE_BASE && rule.id < ADBLOCK_REMOTE_RULE_BASE)
      .map(rule => rule.id);
    const addRules = (enabled ? pausedSites : []).map((domain, index) => ({
      id: ADBLOCK_ALLOW_RULE_BASE + index,
      priority: 100,
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: [domain],
        resourceTypes: ['main_frame', 'sub_frame'],
      },
    }));
    if (removeRuleIds.length > 0 || addRules.length > 0) {
      await api.updateDynamicRules({ removeRuleIds, addRules });
    }
  } catch (e) {}

  try {
    await syncRemoteFilters(api, {
      enabled,
      filters,
      lists,
      existingDynamicRules,
      forceIds: options.forceRemoteIds instanceof Set ? options.forceRemoteIds : new Set(),
    });
  } catch (e) {}
}

// Rapid toggle clicks could otherwise finish out of order; serialise them.
let adBlockSyncQueue = Promise.resolve();
function scheduleAdBlockSync(options = {}) {
  adBlockSyncQueue = adBlockSyncQueue.then(() => syncAdBlockState(options)).catch(() => {});
  return adBlockSyncQueue;
}

_browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[ADBLOCK_KEY] || changes[ADBLOCK_PAUSED_KEY] || changes[ADBLOCK_FILTERS_KEY]) scheduleAdBlockSync();
});


// ── Statistics ──────────────────────────────────────────────────────────────
// Hidden-element activity is aggregated per local calendar day. The chart is
// based on real events; on first use, elements already hidden at that moment
// are recorded as a one-day baseline so the first chart is not misleadingly
// empty.

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDayMap(value) {
  const daily = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return daily;
  for (const [key, count] of Object.entries(value)) {
    const amount = Number(count);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(amount) && amount > 0) {
      daily[key] = Math.round(amount);
    }
  }
  return daily;
}

function normalizeStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const daily = normalizeDayMap(value.daily);
  // Cosmetic filtering was added after the first statistics release. Older
  // records simply have no cleaned series yet.
  const cleanedDaily = normalizeDayMap(value.cleanedDaily);

  const sum = Object.values(daily).reduce((total, amount) => total + amount, 0);
  const cleanedSum = Object.values(cleanedDaily).reduce((total, amount) => total + amount, 0);
  const storedTotal = Number(value.totalHidden);
  const storedCleaned = Number(value.totalCleaned);
  return {
    version: STATS_VERSION,
    since: /^\d{4}-\d{2}-\d{2}$/.test(value.since) ? value.since : localDayKey(),
    updated: /^\d{4}-\d{2}-\d{2}$/.test(value.updated) ? value.updated : localDayKey(),
    baseline: Number.isFinite(Number(value.baseline))
      ? Math.max(0, Math.round(Number(value.baseline)))
      : 0,
    totalHidden: Number.isFinite(storedTotal)
      ? Math.max(0, Math.round(storedTotal), sum)
      : sum,
    totalCleaned: Number.isFinite(storedCleaned)
      ? Math.max(0, Math.round(storedCleaned), cleanedSum)
      : cleanedSum,
    daily,
    cleanedDaily,
  };
}

function pruneDayMap(daily) {
  const keys = Object.keys(daily).sort();
  if (keys.length <= STATS_MAX_DAYS) return;
  const keep = new Set(keys.slice(-STATS_MAX_DAYS));
  for (const key of keys) {
    if (!keep.has(key)) delete daily[key];
  }
}

function pruneStats(stats) {
  pruneDayMap(stats.daily);
  pruneDayMap(stats.cleanedDaily);
  return stats;
}

// Reads the current per-origin selector lists, migrating legacy per-URL keys
// on the way. Shared by the Sites view and by statistics initialization.
async function readHiddenSites() {
  const all = await _browser.storage.local.get(null).catch(() => ({}));
  const selectorsByOrigin = new Map();
  const legacyKeysToRemove = [];

  for (const [key, value] of Object.entries(all)) {
    if (!Array.isArray(value) || value.length === 0) continue;

    if (key.startsWith('dh_site:')) {
      const origin = key.replace('dh_site:', '');
      const set = selectorsByOrigin.get(origin) || new Set();
      for (const selector of value) set.add(selector);
      selectorsByOrigin.set(origin, set);
      continue;
    }

    if (key.startsWith('http://') || key.startsWith('https://')) {
      try {
        const origin = new URL(key).origin;
        const set = selectorsByOrigin.get(origin) || new Set();
        for (const selector of value) set.add(selector);
        selectorsByOrigin.set(origin, set);
        legacyKeysToRemove.push(key);
      } catch (e) {}
    }
  }

  // Only write when legacy per-URL keys actually need migrating. Re-writing
  // every dh_site: key on each read would fire storage.onChanged in a loop.
  if (legacyKeysToRemove.length > 0) {
    const write = {};
    for (const [origin, set] of selectorsByOrigin.entries()) {
      write[`dh_site:${origin}`] = Array.from(set);
    }
    await _browser.storage.local.set(write).catch(() => {});
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

  sites.sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin));
  return { sites, totalHidden };
}

let statsInitPromise = null;
function ensureStatsInitialized() {
  if (statsInitPromise) return statsInitPromise;

  const task = (async () => {
    const data = await _browser.storage.local.get(STATS_KEY).catch(() => ({}));
    const existing = normalizeStats(data[STATS_KEY]);
    if (existing) return existing;

    const { totalHidden } = await readHiddenSites();
    const today = localDayKey();
    const stats = {
      version: STATS_VERSION,
      since: today,
      updated: today,
      baseline: totalHidden,
      totalHidden,
      totalCleaned: 0,
      daily: totalHidden > 0 ? { [today]: totalHidden } : {},
      cleanedDaily: {},
    };

    await _browser.storage.local.set({ [STATS_KEY]: stats }).catch(() => {});
    return stats;
  })();

  statsInitPromise = task.finally(() => {
    statsInitPromise = null;
  });
  return statsInitPromise;
}

// Serialise increments so two hidden elements in quick succession cannot
// overwrite each other's counter update.
let statsWriteQueue = Promise.resolve();
function recordHiddenEvent(count = 1) {
  const amount = Math.max(0, Math.round(Number(count) || 0));
  if (!amount) return statsWriteQueue;

  statsWriteQueue = statsWriteQueue.then(async () => {
    const stats = await ensureStatsInitialized();
    const today = localDayKey();
    stats.daily[today] = (stats.daily[today] || 0) + amount;
    stats.totalHidden += amount;
    stats.updated = today;
    pruneStats(stats);
    await _browser.storage.local.set({ [STATS_KEY]: stats }).catch(() => {});
  }).catch(() => {});

  return statsWriteQueue;
}

// Cosmetic counts arrive on page load, so they are buffered for a few seconds
// instead of writing storage on every navigation. getStatistics flushes the
// buffer first, so the panel never shows a stale number.
const CLEAN_FLUSH_DELAY = 6000;
const CLEAN_PER_PAGE_CAP = 250;
let pendingClean = new Map();
let cleanFlushTimer = null;

function recordCleanEvent(count = 1) {
  const amount = Math.min(
    CLEAN_PER_PAGE_CAP,
    Math.max(0, Math.round(Number(count) || 0))
  );
  if (!amount) return;

  const today = localDayKey();
  pendingClean.set(today, (pendingClean.get(today) || 0) + amount);

  if (!cleanFlushTimer) {
    cleanFlushTimer = setTimeout(() => {
      cleanFlushTimer = null;
      flushCleanEvents();
    }, CLEAN_FLUSH_DELAY);
  }
}

function flushCleanEvents() {
  if (pendingClean.size === 0) return statsWriteQueue;

  const batch = pendingClean;
  pendingClean = new Map();
  if (cleanFlushTimer) {
    clearTimeout(cleanFlushTimer);
    cleanFlushTimer = null;
  }

  statsWriteQueue = statsWriteQueue.then(async () => {
    const stats = await ensureStatsInitialized();
    for (const [day, amount] of batch) {
      stats.cleanedDaily[day] = (stats.cleanedDaily[day] || 0) + amount;
      stats.totalCleaned += amount;
    }
    stats.updated = localDayKey();
    pruneStats(stats);
    await _browser.storage.local.set({ [STATS_KEY]: stats }).catch(() => {});
  }).catch(() => {});

  return statsWriteQueue;
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
          // Make sure an existing hidden total is captured before this new
          // element is written, otherwise the baseline would double-count it.
          await ensureStatsInitialized();
          elements.push(message.selector);
          await _browser.storage.local.set({ [siteKey]: elements });
          await recordHiddenEvent(1);
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
        const { sites, totalHidden } = await readHiddenSites();
        sendResponse({ sites, totalHidden });

      } else if (message.action === 'recordCleanEvent' && tabId != null) {
        // Reported by content.js as cosmetic slots are counted on the page.
        recordCleanEvent(message.count);
        sendResponse({ ok: true });

      } else if (message.action === 'getStatistics') {
        await flushCleanEvents();
        const stats = await ensureStatsInitialized();
        const { sites, totalHidden } = await readHiddenSites();
        sendResponse({ stats, current: { sites, totalHidden } });

      } else if (message.action === 'refreshRemoteFilter') {
        const listId = typeof message.listId === 'string' ? message.listId : '';
        if (!listId) {
          sendResponse({ ok: false, error: 'Missing listId' });
          return;
        }
        await scheduleAdBlockSync({ forceRemoteIds: new Set([listId]) });
        sendResponse({ ok: true });

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

// Tabs that were already open when the extension was installed/updated keep
// running without content scripts (browsers only inject them on page load), so
// keyboard shortcuts would silently do nothing there until the page is
// reloaded or the popup is opened. Inject into those tabs right away.
async function injectContentScriptIntoOpenTabs() {
  const tabs = await _browser.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (!tab?.id || !isInjectableTab(tab)) continue;
    try {
      await ensureContentScript(tab.id);
    } catch (e) {}
  }
}

_browser.runtime.onInstalled.addListener(() => {
  injectContentScriptIntoOpenTabs();
  scheduleAdBlockSync();
  ensureStatsInitialized().catch(() => {});
});

_browser.runtime.onStartup.addListener(() => {
  scheduleAdBlockSync();
  ensureStatsInitialized().catch(() => {});
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
      files: ['cosmetic.js', 'content.js'],
    });
    await _browser.scripting.insertCSS({
      target: { tabId },
      files: ['adblock.css', 'content.css'],
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
