// Filter-list compiler: ABP/uBO/AdGuard filter text -> Safari content-blocker
// rules (grouped by category and list section) + rules for the Bastion web
// extension (scriptlets, procedural cosmetics, CSS injection).

import { preprocess, DEFAULT_ENV } from './directives.js';
import { parseNetworkFilter, convertNetworkFilter, badfilterKey } from './network.js';
import { parseCosmeticFilter, isPlausibleSelector, isSupportedScriptlet } from './cosmetic.js';
import { toWebKitDomains, normalizeDomain, isSubdomainOf } from './domains.js';

export const CATEGORIES = ['ads', 'privacy', 'annoyances', 'social', 'security', 'custom'];

// Order of sections inside a single WebKit rule list. `ignore-previous-rules`
// only cancels rules that appear *before* it, so order is semantics.
//
// $generichide must cancel generic hiding but keep site-specific hiding, so
// generic comes first. ($specifichide also cancels generic rules here; it is
// rare enough in real lists that this is the right trade-off.)
export const SECTION_ORDER = [
  'genericHide',
  'generichideExceptions',
  'specificHide',
  'specifichideExceptions',
  'elemhideExceptions',
  'network',
  'networkExceptions',
  'important',
  'importantExceptions',
  'documentExceptions',
];

const EXCEPTION_SECTIONS = new Set([
  'specifichideExceptions', 'generichideExceptions', 'elemhideExceptions',
  'networkExceptions', 'importantExceptions', 'documentExceptions',
]);
export const isExceptionSection = (s) => EXCEPTION_SECTIONS.has(s);

const HOSTS_LINE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/;
const PLAIN_DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

function newBucket() {
  const b = {};
  for (const s of SECTION_ORDER) b[s] = [];
  return b;
}

function errorCollector() {
  const counts = new Map();
  return {
    add(reason, line) {
      const e = counts.get(reason);
      if (e) {
        e.count++;
        if (e.examples.length < 3) e.examples.push(line);
      } else counts.set(reason, { count: 1, examples: [line] });
    },
    toJSON() {
      return [...counts.entries()]
        .map(([reason, v]) => ({ reason, ...v }))
        .sort((a, b) => b.count - a.count);
    },
  };
}

/**
 * @param {Array<{id:string, text:string, category?:string, trusted?:boolean}>} lists
 * @param {object} [options]
 * @param {(selector:string)=>boolean} [options.validateSelector] - engine-backed CSS check
 * @param {boolean} [options.blockSubframes=true]
 * @param {number} [options.genericBatchSize=128]
 * @param {number} [options.specificBatchSize=64]
 */
export function compile(lists, options = {}) {
  const t0 = Date.now();
  const env = { ...DEFAULT_ENV, ...(options.env || {}) };
  const validateSelector = options.validateSelector || isPlausibleSelector;
  const genericBatchSize = options.genericBatchSize || 128;
  const specificBatchSize = options.specificBatchSize || 64;
  const errors = errorCollector();
  const stats = { lines: 0, network: 0, cosmetic: 0, scriptlets: 0, extended: 0, css: 0, skipped: 0, duplicates: 0, badfiltered: 0 };

  // Pass 1: collect lines and $badfilter targets.
  const entries = [];
  const badfilters = new Set();
  for (const list of lists) {
    const category = CATEGORIES.includes(list.category) ? list.category : 'ads';
    const trusted = list.trusted !== false;
    for (const { line, affinity } of preprocess(list.text, env)) {
      stats.lines++;
      let text = line;
      const hosts = HOSTS_LINE.exec(text);
      if (hosts) {
        const d = normalizeDomain(hosts[1]);
        if (!d || d === 'localhost' || d === '0.0.0.0') continue;
        text = '||' + d + '^';
      } else if (PLAIN_DOMAIN.test(text) && !text.includes('#')) {
        text = '||' + text.toLowerCase() + '^';
      }
      if (/\$(.*,)?badfilter(,|$)/.test(text) && !/#[@?$%]*#/.test(text)) {
        badfilters.add(badfilterKey(text));
        continue;
      }
      entries.push({ text, category: affinity || category, list: list.id, trusted });
    }
  }

  // Per category: section -> rules. Cosmetic rules are aggregated first and
  // emitted at the end so selectors can be batched.
  const buckets = {};
  for (const c of [...CATEGORIES, 'all']) buckets[c] = newBucket();
  const seen = new Set();

  const genericSelectors = new Map(); // selector -> category
  const specificSelectors = new Map(); // selector -> { category, include:Set, exclude:Set }
  const negatedOnlySelectors = new Map(); // selector -> { category, exclude:Set }
  const hideExceptions = new Map(); // selector -> Set(domains) ; '' domain = global

  const web = { scriptlets: [], scriptletExceptions: [], extended: [], extendedExceptions: [], css: [] };
  const webSeen = new Map();

  const pushRule = (category, section, rule) => {
    const key = section + JSON.stringify(rule);
    if (seen.has(key)) {
      stats.duplicates++;
      return;
    }
    seen.add(key);
    buckets[category][section].push(rule);
  };

  for (const entry of entries) {
    const { text, category } = entry;
    const cosmetic = parseCosmeticFilter(text);
    if (cosmetic) {
      stats.cosmetic++;
      if (cosmetic.unsupported) {
        errors.add(cosmetic.unsupported, text);
        stats.skipped++;
        continue;
      }
      handleCosmetic(cosmetic, entry);
      continue;
    }

    // Network filter.
    if (badfilters.size && badfilters.has(badfilterKey(text))) {
      stats.badfiltered++;
      continue;
    }
    stats.network++;
    const f = parseNetworkFilter(text);
    if (!f.pattern && !f.domains && f.modifiers.size === 0) {
      errors.add('empty pattern', text);
      stats.skipped++;
      continue;
    }
    if (!f.isRegex && !f.domains && !f.exception && f.pattern.replace(/[|*^]/g, '').length < 4 && !/^\|\|/.test(f.pattern)) {
      errors.add('pattern too generic', text);
      stats.skipped++;
      continue;
    }
    const res = convertNetworkFilter(f, options);
    if (res.error) {
      errors.add(res.error, text);
      stats.skipped++;
      continue;
    }
    for (const r of res.rules) pushRule(category, res.section, r);
  }

  function handleCosmetic(c, entry) {
    const { include, exclude } = c.domains;
    const webInclude = c.domains.includeRaw;
    const webExclude = c.domains.excludeRaw;
    const category = entry.category;
    switch (c.kind) {
      case 'hide': {
        if (!validateSelector(c.selector)) {
          errors.add('invalid selector', c.raw);
          stats.skipped++;
          return;
        }
        if (c.exception) {
          let set = hideExceptions.get(c.selector);
          if (!set) hideExceptions.set(c.selector, (set = new Set()));
          if (include.length === 0) set.add('');
          for (const d of include) set.add(d);
          return;
        }
        if (include.length) {
          let s = specificSelectors.get(c.selector + '\u0000' + category);
          if (!s) specificSelectors.set(c.selector + '\u0000' + category, (s = { selector: c.selector, category, include: new Set(), exclude: new Set() }));
          for (const d of include) s.include.add(d);
          for (const d of exclude) s.exclude.add(d);
        } else if (exclude.length) {
          let s = negatedOnlySelectors.get(c.selector);
          if (!s) negatedOnlySelectors.set(c.selector, (s = { selector: c.selector, category, exclude: new Set() }));
          for (const d of exclude) s.exclude.add(d);
        } else if (!genericSelectors.has(c.selector)) {
          genericSelectors.set(c.selector, category);
        }
        return;
      }
      case 'extended': {
        stats.extended++;
        const item = { d: webInclude, n: webExclude, sel: c.selector };
        addWeb(c.exception ? web.extendedExceptions : web.extended, item);
        return;
      }
      case 'css': {
        stats.css++;
        if (/^remove\s*:\s*true\s*;?$/i.test(c.style)) {
          // AdGuard: `sel { remove: true; }` removes the element.
          const item = { d: webInclude, n: webExclude, sel: c.selector + ':remove()' };
          if (!c.exception) addWeb(web.extended, item);
          return;
        }
        if (!c.exception && !c.extended && !/[{}<>]/.test(c.style) && !validateSelector(c.selector)) {
          errors.add('invalid selector', c.raw);
          return;
        }
        if (/url\s*\(|expression\s*\(|@import/i.test(c.style)) {
          errors.add('unsafe CSS value', c.raw);
          return;
        }
        if (c.exception) return; // rare; ignored
        addWeb(web.css, { d: webInclude, n: webExclude, sel: c.selector, style: c.style, ext: c.extended || undefined });
        return;
      }
      case 'scriptlet': {
        stats.scriptlets++;
        const all = [c.scriptlet, ...(c.extraScriptlets || [])];
        for (const s of all) {
          if (!isSupportedScriptlet(s.name)) {
            errors.add('unsupported scriptlet ' + s.name, c.raw);
            continue;
          }
          if (/^trusted-|^replace-|^set-cookie|click-element/.test(rawName(c.raw)) && !entry.trusted) {
            errors.add('trusted scriptlet from untrusted list', c.raw);
            continue;
          }
          if (c.exception) addWeb(web.scriptletExceptions, { d: webInclude, s: s.name ? [s.name, ...s.args] : [] });
          else {
            if (include.length === 0 && exclude.length === 0 && /^(set-cookie|set-local-storage-item|set-session-storage-item|close-window|click-element)$/.test(s.name)) {
              errors.add('generic scriptlet not allowed', c.raw);
              continue;
            }
            addWeb(web.scriptlets, { d: webInclude, n: webExclude, s: [s.name, ...s.args] });
          }
        }
        return;
      }
      default:
        errors.add('unsupported cosmetic', c.raw);
    }
  }

  function addWeb(arr, item) {
    let set = webSeen.get(arr);
    if (!set) webSeen.set(arr, (set = new Set()));
    const key = JSON.stringify(item);
    if (set.has(key)) return;
    set.add(key);
    arr.push(item);
  }

  // ---- Emit cosmetic rules -------------------------------------------------
  // Generic selectors without exceptions are batched; generic selectors with
  // domain exceptions get their own rule with unless-domain.
  const genericByCategory = {};
  for (const [selector, category] of genericSelectors) {
    const exc = hideExceptions.get(selector);
    if (exc && exc.has('')) continue; // globally excepted
    if (exc && exc.size) {
      pushRule(category, 'genericHide', {
        trigger: { 'url-filter': '.*', 'unless-domain': toWebKitDomains([...exc]) },
        action: { type: 'css-display-none', selector },
      });
      continue;
    }
    (genericByCategory[category] ||= []).push(selector);
  }
  for (const [selector, s] of negatedOnlySelectors) {
    const exc = hideExceptions.get(selector);
    if (exc && exc.has('')) continue;
    const excluded = new Set(s.exclude);
    if (exc) for (const d of exc) excluded.add(d);
    pushRule(s.category, 'genericHide', {
      trigger: { 'url-filter': '.*', 'unless-domain': toWebKitDomains([...excluded]) },
      action: { type: 'css-display-none', selector },
    });
  }
  for (const [category, selectors] of Object.entries(genericByCategory)) {
    // `:has()` and other newer syntax in separate batches so one unsupported
    // selector cannot take out a large group.
    const plain = selectors.filter((s) => !s.includes(':has('));
    const modern = selectors.filter((s) => s.includes(':has('));
    for (const group of [plain, modern]) {
      for (let i = 0; i < group.length; i += genericBatchSize) {
        pushRule(category, 'genericHide', {
          trigger: { 'url-filter': '.*' },
          action: { type: 'css-display-none', selector: group.slice(i, i + genericBatchSize).join(', ') },
        });
      }
    }
  }

  // Domain-specific: group selectors by identical domain set.
  const byDomainSet = new Map();
  for (const s of specificSelectors.values()) {
    const exc = hideExceptions.get(s.selector);
    let include = [...s.include];
    if (exc) {
      if (exc.has('')) continue;
      include = include.filter((d) => !exc.has(d));
      if (include.length === 0) continue;
    }
    // Excluded subdomains of included domains (a.com,~b.a.com) cannot be
    // carved out of a batched selector; keep the selector, scoped to the
    // included domains that are not themselves excluded.
    include = include.filter((d) => !s.exclude.has(d));
    if (include.length === 0) continue;
    const key = s.category + '|' + include.sort().join(',');
    let g = byDomainSet.get(key);
    if (!g) byDomainSet.set(key, (g = { category: s.category, include, selectors: [] }));
    g.selectors.push(s.selector);
  }
  for (const g of byDomainSet.values()) {
    const plain = g.selectors.filter((s) => !s.includes(':has('));
    const modern = g.selectors.filter((s) => s.includes(':has('));
    for (const group of [plain, modern]) {
      for (let i = 0; i < group.length; i += specificBatchSize) {
        pushRule(g.category, 'specificHide', {
          trigger: { 'url-filter': '.*', 'if-domain': toWebKitDomains(g.include) },
          action: { type: 'css-display-none', selector: group.slice(i, i + specificBatchSize).join(', ') },
        });
      }
    }
  }

  // Flatten the 'all' bucket into every category so each extension has it.
  const result = { categories: {}, web, stats, errors: errors.toJSON(), durationMs: 0 };
  for (const c of CATEGORIES) result.categories[c] = buckets[c];
  result.shared = buckets.all;
  stats.webRules = web.scriptlets.length + web.extended.length + web.css.length;
  let total = 0;
  for (const c of [...CATEGORIES]) for (const s of SECTION_ORDER) total += buckets[c][s].length;
  for (const s of SECTION_ORDER) total += buckets.all[s].length;
  stats.contentBlockerRules = total;
  result.durationMs = Date.now() - t0;
  return result;
}

function rawName(raw) {
  const m = /\+js\(\s*([^,)]+)/.exec(raw) || /scriptlet\(\s*['"]([^'"]+)/.exec(raw);
  return m ? m[1].trim().replace(/^ubo-/, '') : '';
}

export { isSubdomainOf };
