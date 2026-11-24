/**
 * generate_rules.js — Builds the ad/tracker rulesets used by
 * declarativeNetRequest (rules/*.json) plus the metadata that powers the
 * control panel's Filters tab (rules/lists.json).
 *
 * Run after editing the lists below, or after refreshing the regional data:
 *   node generate_regional.js --refresh
 *   node generate_rules.js
 *
 * The generated files are committed. The browser compiles them natively, so
 * blocking costs no per-request JavaScript and no content-script work.
 */

const fs = require('fs');
const path = require('path');

const REGIONAL_SOURCES = require('./regional-sources.json');

// Requests that can carry ads. main_frame is deliberately excluded: clicking a
// link to an ad network should still navigate instead of dying on a blank page.
const RESOURCE_TYPES = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'media',
  'websocket',
  'other',
];

// Curated, high-confidence ad delivery and ad-serving hosts. One entry covers
// the whole domain tree (example.com also matches cdn.example.com).
const CORE_AD_HOSTS = [
  // Google, Microsoft, Amazon and social ad delivery
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'adservice.google.com',
  'googletagservices.com',
  '2mdn.net',
  'amazon-adsystem.com',
  'assoc-amazon.com',
  'ads.yahoo.com',
  'ads.linkedin.com',
  'ads.tiktok.com',
  'ads.twitter.com',
  'ads.pinterest.com',

  // Exchanges, SSPs and ad servers
  'adnxs.com',
  'adnxs-simple.com',
  'appnexus.com',
  'rubiconproject.com',
  'magnite.com',
  'pubmatic.com',
  'openx.net',
  'criteo.com',
  'criteo.net',
  'casalemedia.com',
  '33across.com',
  'sharethrough.com',
  'triplelift.com',
  'teads.tv',
  'smartadserver.com',
  'sascdn.com',
  'adform.net',
  'adition.com',
  'yieldmo.com',
  'sovrn.com',
  'lijit.com',
  'indexexchange.com',
  'contextweb.com',
  'districtm.io',
  'media.net',
  'mnet-ad.net',
  'advertising.com',
  'adap.tv',
  'amobee.com',
  'bidswitch.net',
  'gumgum.com',
  'undertone.com',
  'spotxchange.com',
  'spotx.tv',
  '1rx.io',
  'adroll.com',
  'adsrvr.org',
  'bidr.io',
  '360yield.com',
  'improvedigital.com',
  'yieldlab.net',
  'freewheel.tv',
  'fwmrm.net',
  'stickyadstv.com',
  'innovid.com',
  'tremorhub.com',
  'tremorvideo.com',
  'telaria.com',
  'springserve.com',
  'serving-sys.com',
  'flashtalking.com',
  'conversantmedia.com',
  'dotomi.com',
  'exponential.com',
  'tribalfusion.com',
  'valueclick.com',
  'fastclick.net',
  'adbutler.com',
  'servedbyadbutler.com',
  'admarketplace.com',
  'bidmachine.io',
  'smaato.com',
  'aniview.com',
  'adhese.com',
  'engageya.com',
  'kargo.com',
  'primis.tech',
  'connatix.com',
  'vidazoo.com',
  'adskeeper.com',
  'setupad.com',
  'adlightning.com',
  'blockthrough.com',
  'buysellads.com',
  'carbonads.com',
  'mediavine.com',
  'adthrive.com',
  'ezoic.net',
  'monumetric.com',

  // Native / sponsored content
  'taboola.com',
  'outbrain.com',
  'zemanta.com',
  'plista.com',
  'ligatus.com',
  'nativo.com',
  'mgid.com',
  'revcontent.com',
  'zergnet.com',
  'dianomi.com',
  'adsnative.com',
  'seedtag.com',
  'ogury.com',
  'loopme.me',
  'infolinks.com',
  'vibrantmedia.com',
  'intellitxt.com',

  // Turkish ad platforms (kept in the always-on core list so they stay
  // blocked even when the optional regional Turkish list is disabled).
  'adhood.com',
  'admatic.com.tr',
  'admost.com',
];

// Pop-under, push and low-quality ad networks. Kept in their own optional list
// because these are the hosts most likely to trip a false positive.
const RISKY_AD_HOSTS = [
  'adcash.com',
  'propellerads.com',
  'propellersads.com',
  'popads.net',
  'popcash.net',
  'adsterra.com',
  'hilltopads.net',
  'clickadu.com',
  'exoclick.com',
  'juicyads.com',
  'trafficjunky.net',
  'trafficstars.com',
  'tsyndicate.com',
  'evadav.com',
  'galaksion.com',
  'adspyglass.com',
  'ad-maven.com',
  'bidvertiser.com',
  'clicksor.com',
];

// In-app ad SDKs and mobile mediation networks.
const MOBILE_AD_HOSTS = [
  'applovin.com',
  'applvn.com',
  'unityads.unity3d.com',
  'ironsrc.com',
  'supersonicads.com',
  'vungle.com',
  'chartboost.com',
  'mintegral.com',
  'mopub.com',
  'inmobi.com',
  'startapp.com',
  'tapjoy.com',
  'adcolony.com',
  'fyber.com',
  'appodeal.com',
  'digitalturbine.com',
  'liftoff.io',
  'mobvista.com',
];

// Regional ad platforms move in through regional-sources.json; see
// generate_regional.js. They are off by default, like uBlock's language lists.

const LISTS = [
  {
    id: 'ads',
    file: 'ads.json',
    category: 'ads',
    nameKey: 'filterAdsName',
    descKey: 'filterAdsDesc',
    hosts: CORE_AD_HOSTS,
    defaultEnabled: true,
    recommended: true,
  },
  {
    id: 'privacy',
    file: 'easyprivacy.json',
    external: true,
    category: 'privacy',
    nameKey: 'filterEasyPrivacyName',
    descKey: 'filterEasyPrivacyDesc',
    defaultEnabled: true,
    recommended: true,
    attribution: 'EasyPrivacy',
  },
  {
    id: 'mobile',
    file: 'mobile.json',
    category: 'ads',
    nameKey: 'filterMobileName',
    descKey: 'filterMobileDesc',
    hosts: MOBILE_AD_HOSTS,
    defaultEnabled: true,
    recommended: false,
  },
  {
    id: 'risky',
    file: 'risky.json',
    category: 'security',
    nameKey: 'filterRiskyName',
    descKey: 'filterRiskyDesc',
    hosts: RISKY_AD_HOSTS,
    defaultEnabled: true,
    recommended: false,
  },
];

const CATEGORIES = [
  { id: 'ads', nameKey: 'categoryAds' },
  { id: 'privacy', nameKey: 'categoryPrivacy' },
  { id: 'security', nameKey: 'categorySecurity' },
  { id: 'regional', nameKey: 'categoryRegional' },
];

const DOMAINS_PER_RULE = 200;

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function normalizeHosts(hosts) {
  const seen = new Set();
  const result = [];
  for (const raw of hosts) {
    const host = String(raw).trim().toLowerCase();
    if (!DOMAIN_RE.test(host)) {
      throw new Error(`Invalid domain: ${raw}`);
    }
    if (seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result;
}

const outDir = path.join(__dirname, 'rules');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

const metadata = [];
const allHosts = new Set();

function readRegionalMetadata() {
  const result = [];
  const missing = [];

  for (const source of REGIONAL_SOURCES) {
    const filePath = path.join(outDir, `${source.id}.json`);
    if (!fs.existsSync(filePath)) {
      missing.push(source.id);
      continue;
    }

    const rules = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(rules)) {
      throw new Error(`Regional ruleset is not an array: ${source.id}.json`);
    }

    const domains = new Set();
    for (const rule of rules) {
      for (const domain of rule.condition?.requestDomains || []) {
        const value = String(domain).toLowerCase();
        domains.add(value);
        allHosts.add(value);
      }
    }

    result.push({
      id: source.id,
      file: `rules/${source.id}.json`,
      category: 'regional',
      name: source.name,
      descKey: 'filterRegionalDesc',
      defaultEnabled: false,
      recommended: false,
      ruleCount: rules.length,
      domainCount: domains.size,
      langs: source.langs,
      autoLangs: source.autoLangs || [],
      homepage: source.homepage,
    });

    console.log(
      `${source.id.padEnd(16)} → rules/${source.id}.json (${rules.length} rules, ${domains.size} domains)`
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing regional rulesets: ${missing.join(', ')}. Run "node generate_regional.js --refresh" first.`
    );
  }

  return result;
}

for (const list of LISTS) {
  if (list.external) {
    const filePath = path.join(outDir, list.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing external ruleset: ${list.file}`);
    }
    const rules = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(rules)) {
      throw new Error(`External ruleset is not an array: ${list.file}`);
    }

    const domains = new Set();
    let allowCount = 0;
    for (const rule of rules) {
      if (rule.action?.type === 'allow') allowCount++;
      for (const domain of rule.condition?.requestDomains || []) {
        domains.add(String(domain).toLowerCase());
      }
    }

    metadata.push({
      id: list.id,
      file: `rules/${list.file}`,
      category: list.category,
      nameKey: list.nameKey,
      descKey: list.descKey,
      defaultEnabled: list.defaultEnabled,
      recommended: list.recommended,
      ruleCount: rules.length,
      domainCount: domains.size,
      allowRuleCount: allowCount,
      attribution: list.attribution,
    });

    console.log(
      `${list.id.padEnd(8)} → rules/${list.file} (external, ${rules.length} rules, ${domains.size} domains)`
    );
    continue;
  }

  const hosts = normalizeHosts(list.hosts);
  const rules = [];
  let nextId = 1;

  const blockRule = (condition) => {
    rules.push({
      id: nextId++,
      priority: 1,
      action: { type: 'block' },
      condition,
    });
  };

  for (const group of chunk(hosts, DOMAINS_PER_RULE)) {
    blockRule({ requestDomains: group, resourceTypes: RESOURCE_TYPES });
  }

  for (const rule of list.pathRules || []) {
    blockRule({ urlFilter: rule.urlFilter, resourceTypes: rule.resourceTypes });
  }

  for (const host of hosts) allHosts.add(host);

  fs.writeFileSync(path.join(outDir, list.file), JSON.stringify(rules, null, 2) + '\n');

  metadata.push({
    id: list.id,
    file: `rules/${list.file}`,
    category: list.category,
    nameKey: list.nameKey,
    descKey: list.descKey,
    defaultEnabled: list.defaultEnabled,
    recommended: list.recommended,
    ruleCount: rules.length,
    domainCount: hosts.length,
  });

  console.log(
    `${list.id.padEnd(8)} → rules/${list.file} (${rules.length} rules, ${hosts.length} domains)`
  );
}

const regional = readRegionalMetadata();
metadata.push(...regional);

const manifestOut = {
  categories: CATEGORIES,
  lists: metadata,
};

fs.writeFileSync(
  path.join(outDir, 'lists.json'),
  JSON.stringify(manifestOut, null, 2) + '\n'
);

// Keep manifest rule_resources in lockstep with the catalogue. The browser
// needs every static ruleset declared up front; enablement is then toggled at
// runtime through declarativeNetRequest.updateEnabledRulesets().
const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.declarative_net_request = {
  rule_resources: metadata.map(list => ({
    id: list.id,
    enabled: list.defaultEnabled === true,
    path: list.file,
  })),
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const totalRules = metadata.reduce((sum, list) => sum + list.ruleCount, 0);
console.log(
  `\nGenerated ${metadata.length} rulesets ` +
  `(${LISTS.length} core + ${regional.length} regional) — ` +
  `${totalRules} rules, ${allHosts.size} unique domains.`
);
console.log(`Updated manifest.json with ${metadata.length} rule_resources.`);
