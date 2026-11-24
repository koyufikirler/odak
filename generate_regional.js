/**
 * generate_regional.js — Builds the regional filter rulesets.
 *
 * The list catalogue mirrors uBlock Origin's "regions" group (38 lists). Each
 * list is downloaded at build time, converted to the subset of rules that
 * declarativeNetRequest can express natively, and written to rules/<id>.json.
 *
 * Cosmetic rules (`##`, `#@#`, …) are ignored: ODAK ships its own small
 * cosmetic sheet. Rules using features DNR cannot express ($redirect, $csp,
 * $removeparam, …) are skipped rather than approximated.
 *
 * Usage:
 *   node generate_regional.js            # use cached downloads
 *   node generate_regional.js --refresh  # download fresh copies first
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { domainToASCII } = require('url');

const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, '.regional-cache');
const RULES_DIR = path.join(ROOT, 'rules');

const ALL_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

const TYPE_MAP = {
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

// Options that would need a DNR feature we do not use, or that only make sense
// for cosmetic filtering. Rules carrying them are dropped.
const SKIP_OPTIONS = new Set([
  'redirect', 'redirect-rule', 'csp', 'removeparam', 'replace', 'rewrite',
  'empty', 'mp4', 'inline-script', 'inline-font', 'webrtc', 'cookie',
  'permissions', 'urltransform', 'method', 'header', 'badfilter',
  'generichide', 'elemhide', 'specifichide', 'genericblock', 'document',
  'doc', 'popup', 'popunder', 'match-case', 'sitekey', 'denyallow', 'to',
  'from', 'all',
]);

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const ASCII_RE = /^[\x20-\x7e]+$/;
const DOMAINS_PER_RULE = 200;

const SOURCES = require('./regional-sources.json');

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

// A hash avoids the truncation collisions that occur when two lists share a
// long URL prefix (for example .../subscription/easylist-thailand.txt and
// .../subscription/ublock.txt).
function cacheName(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32) + '.txt';
}

async function download(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ODAK filter build (+https://github.com/koyufikirler/odak)' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function readSource(url, refresh) {
  const cached = path.join(CACHE_DIR, cacheName(url));
  if (!refresh && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');

  const text = await download(url);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, text);
  return text;
}

async function loadWithIncludes(url, refresh, seen = new Set(), depth = 0) {
  if (seen.has(url) || depth > 3) return '';
  seen.add(url);

  const text = await readSource(url, refresh);
  const lines = [];
  const base = isHttp(url) ? url : 'https://example.invalid/';

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const include = line.match(/^!#include\s+(\S+)/);
    if (include) {
      let target;
      try {
        target = new URL(include[1], base).toString();
      } catch (e) {
        continue;
      }
      lines.push(await loadWithIncludes(target, refresh, seen, depth + 1));
      continue;
    }
    lines.push(raw);
  }

  return lines.join('\n');
}

function parseOptions(raw) {
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
    if (SKIP_OPTIONS.has(key)) return null;
    if (TYPE_MAP[key]) {
      if (neg) opts.negTypes.push(TYPE_MAP[key]);
      else opts.types.push(TYPE_MAP[key]);
      continue;
    }
    return null;
  }

  return opts;
}

// Turns one ABP line into a partial DNR rule. Returns null when the rule cannot
// be represented faithfully.
function convertLine(line, isException, bareHost) {
  let body = isException ? line.slice(2) : line;
  body = body.trim();
  if (!body) return null;
  if (body.startsWith('/') && body.endsWith('/')) return null; // regexFilter
  if (body.includes('##') || body.includes('#@#') || body.includes('#$#') || body.includes('#%#') || body.includes('#?#')) return null;

  let pattern = body;
  let optionsRaw = '';
  const dollar = body.lastIndexOf('$');
  if (dollar !== -1) {
    pattern = body.slice(0, dollar);
    optionsRaw = body.slice(dollar + 1);
  }
  if (!pattern) return null;
  // DNR url filters never contain whitespace; a match here means the line was
  // not a real filter (for example a malformed comment).
  if (/[\s\x00-\x1f]/.test(pattern)) return null;

  const opts = parseOptions(optionsRaw);
  if (!opts) return null;
  if (isException && !opts.important) {
    // An exception that only lists resource types is fine; DNR allow rules
    // still support resourceTypes, so nothing else is needed here.
  }

  const condition = {};

  // A bare host line (CERT.PL, some regional lists) means "block this host".
  const effectivePattern = bareHost ? `||${pattern}^` : pattern;

  // `||host^` becomes a native domain match. Internationalised hosts are
  // converted to punycode; DNR requires ASCII in domains and url filters.
  const exactHost = effectivePattern.match(/^\|\|([^/*|^]+)\^$/);
  if (exactHost) {
    const ascii = toAsciiHost(exactHost[1]);
    if (ascii) condition.requestDomains = [ascii];
  }

  if (!condition.requestDomains) {
    if (!ASCII_RE.test(effectivePattern)) return null;
    if (effectivePattern.startsWith('||*')) return null;
    if (effectivePattern.length > 200) return null;
    condition.urlFilter = effectivePattern;
  }

  if (opts.thirdParty && !opts.firstParty) condition.domainType = 'thirdParty';
  if (opts.firstParty && !opts.thirdParty) condition.domainType = 'firstParty';

  const initiators = cleanDomains(opts.initiators);
  const excluded = cleanDomains(opts.excludedInitiators);
  if (initiators.length) condition.initiatorDomains = initiators;
  if (excluded.length) condition.excludedInitiatorDomains = excluded;
  if (opts.initiators.length && initiators.length === 0) return null;
  if (opts.excludedInitiators.length && excluded.length === 0) return null;

  // DNR treats a rule without resourceTypes as "everything except the main
  // frame", which is exactly what an ad-block rule should do. Only spell the
  // list out when the filter asked for a subset.
  if (opts.types.length) {
    condition.resourceTypes = [...new Set(opts.types)];
  } else if (opts.negTypes.length) {
    condition.resourceTypes = ALL_TYPES.filter(type => !opts.negTypes.includes(type));
    if (condition.resourceTypes.length === 0) return null;
  }

  return {
    priority: isException ? 3 : opts.important ? 4 : 1,
    action: { type: isException ? 'allow' : 'block' },
    condition,
  };
}

function toAsciiHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return null;
  if (DOMAIN_RE.test(host)) return host;
  try {
    const ascii = domainToASCII(host);
    if (ascii && DOMAIN_RE.test(ascii)) return ascii;
  } catch (e) {}
  return null;
}

function cleanDomains(values) {
  const result = [];
  for (const value of values) {
    const ascii = toAsciiHost(value.replace(/^\*\./, ''));
    if (ascii && !result.includes(ascii)) result.push(ascii);
  }
  return result;
}

function stableKey(rule) {
  const { requestDomains, ...rest } = rule.condition;
  return JSON.stringify([rule.priority, rule.action.type, rest]);
}

function buildRules(text) {
  const groups = new Map();
  const urlRules = [];
  const seenUrl = new Set();

  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    // `#` starts a comment in hosts-style lists and is never a valid network
    // filter; `!` and `[` cover the Adblock/uBlock header conventions.
    if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) continue;

    const isException = line.startsWith('@@');
    if (isException) line = line.slice(2).trim();

    const bareHost = !line.startsWith('@@') && !line.startsWith('|') && !line.startsWith('.') && HOST_RE.test(line) && line.includes('.');
    const rule = convertLine(isException ? `@@${line}` : line, isException, bareHost);
    if (!rule) continue;

    if (rule.condition.requestDomains) {
      const key = stableKey(rule);
      if (!groups.has(key)) groups.set(key, { rule, domains: new Set() });
      for (const domain of rule.condition.requestDomains) groups.get(key).domains.add(domain);
    } else {
      const key = JSON.stringify(rule);
      if (seenUrl.has(key)) continue;
      seenUrl.add(key);
      urlRules.push(rule);
    }
  }

  const rules = [];
  let id = 1;
  for (const { rule, domains } of groups.values()) {
    const list = [...domains].sort();
    for (let i = 0; i < list.length; i += DOMAINS_PER_RULE) {
      const chunk = list.slice(i, i + DOMAINS_PER_RULE);
      rules.push({
        id: id++,
        priority: rule.priority,
        action: rule.action,
        condition: { ...rule.condition, requestDomains: chunk },
      });
    }
  }
  for (const rule of urlRules) rules.push({ id: id++, ...rule });

  return rules;
}

function withIds(metadata, list) {
  return { ...metadata, ...list };
}

async function loadSource(source, refresh) {
  let lastError = null;
  for (const url of source.urls) {
    try {
      return await loadWithIncludes(url, refresh);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No source URL for ${source.id}`);
}

async function buildRegionalLists({ refresh = false, verbose = true } = {}) {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  const metadata = [];
  const failures = [];

  for (const source of SOURCES) {
    let text;
    try {
      text = await loadSource(source, refresh);
    } catch (error) {
      failures.push({ id: source.id, error });
      console.error(`  ${source.id.padEnd(16)} FAILED  ${error.message}`);
      continue;
    }

    const rules = buildRules(text);
    const domains = new Set();
    for (const rule of rules) {
      for (const domain of rule.condition.requestDomains || []) domains.add(domain);
    }

    const file = `${source.id}.json`;
    fs.writeFileSync(
      path.join(RULES_DIR, file),
      JSON.stringify(rules, null, 0) + '\n'
    );

    metadata.push(
      withIds(source, {
        file: `rules/${file}`,
        category: 'regional',
        defaultEnabled: false,
        recommended: false,
        ruleCount: rules.length,
        domainCount: domains.size,
      })
    );

    if (verbose) {
      const warning = rules.length === 0 ? '  (cosmetic-only — no network rules)' : '';
      console.log(
        `  ${source.id.padEnd(16)} ${String(rules.length).padStart(6)} rules  ${String(domains.size).padStart(6)} domains${warning}`
      );
    }
  }

  if (failures.length > 0) {
    const error = new Error(
      `${failures.length} regional list(s) could not be downloaded: ${failures.map(item => item.id).join(', ')}`
    );
    error.failures = failures;
    error.metadata = metadata;
    throw error;
  }

  return metadata;
}

module.exports = { buildRegionalLists };

if (require.main === module) {
  const refresh = process.argv.includes('--refresh');
  buildRegionalLists({ refresh }).then(list => {
    const rules = list.reduce((sum, item) => sum + item.ruleCount, 0);
    console.log(`\n${list.length} regional rulesets, ${rules} rules total.`);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
