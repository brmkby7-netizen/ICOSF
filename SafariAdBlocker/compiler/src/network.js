// Network filter parsing (ABP / uBO / AdGuard syntax) and conversion into
// WebKit content-blocker rules.

import { abpPatternToRegex, jsRegexToWebKit, validateWebKitRegex, HOST_PREFIX, PatternError } from './pattern.js';
import { parseDomainList, toWebKitDomains, normalizeDomain } from './domains.js';

// ABP type option -> WebKit resource types. `null` = cannot be expressed.
const TYPE_MAP = {
  script: ['script'],
  image: ['image'],
  stylesheet: ['style-sheet'],
  css: ['style-sheet'],
  font: ['font'],
  media: ['media'],
  xmlhttprequest: ['raw'],
  xhr: ['raw'],
  websocket: ['raw'],
  other: ['raw'],
  ping: ['ping'],
  beacon: ['ping'],
  object: ['media'],
  'object-subrequest': ['media'],
  subdocument: ['document'],
  frame: ['document'],
  document: ['document'],
  doc: ['document'],
  popup: ['popup'],
  webrtc: null,
};

// Types a filter applies to when it lists none (ABP: everything except
// top-level documents and popups).
const DEFAULT_TYPES = ['image', 'style-sheet', 'script', 'font', 'raw', 'svg-document', 'media', 'ping'];
const ALL_SUBRESOURCE_TYPES = [...DEFAULT_TYPES, 'document'];

// Options that change what a rule means in ways Safari cannot reproduce. A
// rule carrying any of these is skipped rather than approximated.
const UNSUPPORTED_OPTIONS = new Set([
  'csp', 'removeparam', 'queryprune', 'removeheader', 'header', 'permissions', 'replace', 'hls',
  'jsonprune', 'xmlprune', 'cookie', 'stealth', 'referrerpolicy', 'urltransform', 'uritransform',
  'rewrite', 'redirect-rule', 'inline-script', 'inline-font', 'method', 'to',
  'app', 'network', 'extension', 'content', 'jsinject', 'genericblock', 'ipaddress', 'header',
  'reason', 'urlskip', 'responseheader', 'requestheader',
]);

const IGNORED_OPTIONS = new Set(['empty', 'mp4', 'match-case', 'strict1p', 'strict3p', 'first-party', '1p', '3p']);

export function splitOptions(text) {
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === ',') {
      cur += ',';
      i++;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Locates the `$options` part of a network filter. */
export function findOptionsIndex(line) {
  if (line.startsWith('/')) {
    const slashDollar = line.lastIndexOf('/$');
    if (slashDollar > 0) return slashDollar + 1;
    if (line.endsWith('/')) return -1;
  }
  const idx = line.lastIndexOf('$');
  if (idx < 0) return -1;
  const rest = line.slice(idx + 1);
  if (!/^~?[a-z0-9_-]+(=|,|$)/i.test(rest)) return -1;
  return idx;
}

export function parseNetworkFilter(text) {
  let line = text;
  const exception = line.startsWith('@@');
  if (exception) line = line.slice(2);

  let pattern = line;
  let optionList = [];
  const optIdx = findOptionsIndex(line);
  if (optIdx >= 0) {
    pattern = line.slice(0, optIdx);
    optionList = splitOptions(line.slice(optIdx + 1));
  }

  const f = {
    raw: text,
    exception,
    pattern,
    isRegex: pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/'),
    types: new Set(),
    notTypes: new Set(),
    thirdParty: null, // true | false | null
    matchCase: false,
    important: false,
    badfilter: false,
    domains: null,
    denyallow: [],
    modifiers: new Set(), // elemhide, generichide, specifichide, urlblock, document (exception)
    unsupported: null,
  };

  for (const opt of optionList) {
    let name = opt;
    let value = null;
    const eq = opt.indexOf('=');
    if (eq > 0) {
      name = opt.slice(0, eq);
      value = opt.slice(eq + 1);
    }
    let negated = false;
    if (name.startsWith('~')) {
      negated = true;
      name = name.slice(1);
    }
    name = name.toLowerCase();

    if (name === 'domain' || name === 'from') {
      f.domains = parseDomainList(value, '|');
      if (f.domains.unsupported.length && !f.domains.include.length && !f.domains.exclude.length) {
        f.unsupported = 'domain entities only';
      }
      continue;
    }
    if (name === 'denyallow') {
      for (const d of (value || '').split('|')) {
        const n = normalizeDomain(d);
        if (n) f.denyallow.push(n);
        else f.unsupported = 'denyallow value';
      }
      continue;
    }
    if (name === 'third-party' || name === '3p') {
      f.thirdParty = !negated;
      continue;
    }
    if (name === 'first-party' || name === '1p' || name === 'strict1p') {
      f.thirdParty = negated;
      continue;
    }
    if (name === 'strict3p') {
      f.thirdParty = true;
      continue;
    }
    if (name === 'match-case') {
      f.matchCase = !negated;
      continue;
    }
    if (name === 'important') {
      f.important = true;
      continue;
    }
    if (name === 'badfilter') {
      f.badfilter = true;
      continue;
    }
    if (name === 'all') {
      for (const t of [...ALL_SUBRESOURCE_TYPES, 'popup']) f.types.add(t);
      f.modifiers.add('all');
      continue;
    }
    if (exception && ['elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide', 'urlblock'].includes(name)) {
      const canonical = { ehide: 'elemhide', ghide: 'generichide', shide: 'specifichide' }[name] || name;
      f.modifiers.add(canonical);
      continue;
    }
    if (name === 'document' || name === 'doc') {
      if (exception) {
        f.modifiers.add('document');
        continue;
      }
    }
    if (name === 'subdocument' || name === 'frame') {
      if (negated) f.notTypes.add('subdocument');
      else f.types.add('subdocument');
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TYPE_MAP, name)) {
      const mapped = TYPE_MAP[name];
      if (negated) {
        if (mapped) for (const t of mapped) f.notTypes.add(t);
      } else if (mapped) {
        for (const t of mapped) f.types.add(t);
      } else {
        f.types.add('__unsupported__');
      }
      continue;
    }
    if (name === 'redirect' || name === 'rewrite') {
      // uBO/AdGuard `$redirect` = block + serve a neutered resource. Safari
      // cannot redirect, so keep the block (what uBO does without the asset).
      if (exception) f.unsupported = '$redirect exception';
      continue;
    }
    if (name === 'stealth' && exception) {
      f.unsupported = 'ignored: $stealth';
      continue;
    }
    if (UNSUPPORTED_OPTIONS.has(name)) {
      f.unsupported = '$' + name;
      continue;
    }
    if (IGNORED_OPTIONS.has(name)) continue;
    f.unsupported = 'unknown option $' + name;
  }
  return f;
}

/** Canonical text used to match $badfilter rules against their targets. */
export function badfilterKey(text) {
  const f = parseNetworkFilter(text);
  const optIdx = findOptionsIndex(text.startsWith('@@') ? text.slice(2) : text);
  let opts = [];
  if (optIdx >= 0) {
    const body = text.startsWith('@@') ? text.slice(2) : text;
    opts = splitOptions(body.slice(optIdx + 1)).filter((o) => o.toLowerCase() !== 'badfilter');
  }
  return (f.exception ? '@@' : '') + f.pattern + (opts.length ? '$' + opts.sort().join(',') : '');
}

function resourceTypes(f) {
  const types = new Set(f.types);
  types.delete('__unsupported__');
  const hadOnlyUnsupported = f.types.size > 0 && types.size === 0;
  if (hadOnlyUnsupported) return { unsupported: true };

  let subdocument = false;
  if (types.has('subdocument')) {
    types.delete('subdocument');
    subdocument = true;
  }

  if (types.size === 0 && !subdocument) {
    if (f.notTypes.size) {
      const base = new Set(ALL_SUBRESOURCE_TYPES);
      for (const t of f.notTypes) base.delete(t === 'subdocument' ? 'document' : t);
      return { types: [...base], subdocument: false };
    }
    return { types: null, subdocument: false }; // defaults
  }
  for (const t of f.notTypes) types.delete(t);
  return { types: [...types], subdocument };
}

function makeTrigger(regex, f, extra) {
  const trigger = { 'url-filter': regex };
  if (f.matchCase) trigger['url-filter-is-case-sensitive'] = true;
  Object.assign(trigger, extra);
  if (f.thirdParty === true) trigger['load-type'] = ['third-party'];
  else if (f.thirdParty === false) trigger['load-type'] = ['first-party'];
  return trigger;
}

/**
 * Converts a parsed network filter into WebKit rules.
 * Returns { rules: [...], section } or { error } describing why it was skipped.
 * `section` tells the compiler where in the list order the rules belong.
 */
export function convertNetworkFilter(f, options = {}) {
  if (f.unsupported) return { error: f.unsupported };
  if (f.modifiers.has('genericblock')) return { error: '$genericblock' };

  // Regexes for the url-filter.
  let regexes;
  let host = null;
  try {
    if (f.isRegex) {
      regexes = jsRegexToWebKit(f.pattern.slice(1, -1));
    } else {
      const r = abpPatternToRegex(f.pattern);
      regexes = [r.regex];
      host = r.host;
    }
  } catch (e) {
    if (e instanceof PatternError) return { error: 'pattern: ' + e.message };
    throw e;
  }
  for (const re of regexes) {
    const problem = validateWebKitRegex(re);
    if (problem) return { error: 'url-filter: ' + problem };
  }

  const include = f.domains ? f.domains.include : [];
  const exclude = f.domains ? f.domains.exclude : [];
  if (f.domains && f.domains.unsupported.length && include.length === 0 && exclude.length === 0) {
    return { error: 'domain entities only' };
  }
  // Rules restricted only to unsupported entity domains (example.*) would
  // otherwise become global; skip them.
  if (f.domains && f.domains.unsupported.some((d) => !d.startsWith('~')) && include.length === 0) {
    return { error: 'domain entities only' };
  }

  // Exceptions that act on whole pages.
  if (f.exception && (f.modifiers.has('document') || f.modifiers.has('elemhide') || f.modifiers.has('generichide') || f.modifiers.has('specifichide') || f.modifiers.has('urlblock'))) {
    const pageDomains = [...include];
    if (host) pageDomains.push(host);
    if (pageDomains.length === 0) return { error: 'page-level exception without a domain' };
    if (!host && f.pattern && f.pattern !== '*' && f.pattern !== '') {
      return { error: 'page-level exception with a path' };
    }
    const trigger = { 'url-filter': '.*', 'if-domain': toWebKitDomains(pageDomains) };
    const action = { type: 'ignore-previous-rules' };
    let section;
    if (f.modifiers.has('document')) section = 'documentExceptions';
    else if (f.modifiers.has('urlblock')) section = 'networkExceptions';
    else if (f.modifiers.has('generichide')) section = 'generichideExceptions';
    else if (f.modifiers.has('specifichide')) section = 'specifichideExceptions';
    else section = 'elemhideExceptions';
    const rules = [{ trigger, action }];
    return { rules, section };
  }

  const rt = resourceTypes(f);
  if (rt.unsupported) return { error: 'unsupported resource types' };

  const domainCondition = {};
  if (include.length) domainCondition['if-domain'] = toWebKitDomains(include);
  else if (exclude.length) domainCondition['unless-domain'] = toWebKitDomains(exclude);

  const actionType = f.exception ? 'ignore-previous-rules' : 'block';
  const rules = [];
  for (const regex of regexes) {
    if (rt.types === null) {
      if (host && !f.exception) {
        // `||adserver.com^`: block everything from that host (strict blocking).
        rules.push({ trigger: makeTrigger(regex, f, domainCondition), action: { type: actionType } });
      } else {
        rules.push({ trigger: makeTrigger(regex, f, { ...domainCondition, 'resource-type': [...DEFAULT_TYPES] }), action: { type: actionType } });
        if (options.blockSubframes !== false) {
          rules.push({
            trigger: makeTrigger(regex, f, { ...domainCondition, 'resource-type': ['document'], 'load-context': ['child-frame'] }),
            action: { type: actionType },
          });
        }
      }
    } else {
      if (rt.types.length) {
        rules.push({ trigger: makeTrigger(regex, f, { ...domainCondition, 'resource-type': rt.types.sort() }), action: { type: actionType } });
      }
      if (rt.subdocument) {
        rules.push({
          trigger: makeTrigger(regex, f, { ...domainCondition, 'resource-type': ['document'], 'load-context': ['child-frame'] }),
          action: { type: actionType },
        });
      }
    }
  }
  if (rules.length === 0) return { error: 'no applicable resource types' };

  // Mixed include/exclude ("domain=a.com|~sub.a.com"): carve out the
  // excluded subdomains with a scoped exception placed right after.
  if (include.length && exclude.length && !f.exception) {
    const carve = rules.map((r) => {
      const trigger = { ...r.trigger, 'if-domain': toWebKitDomains(exclude) };
      return { trigger, action: { type: 'ignore-previous-rules' } };
    });
    rules.push(...carve);
  }

  // $denyallow: block except when the request goes to the listed domains.
  if (f.denyallow.length && !f.exception) {
    for (const d of f.denyallow) {
      const re = HOST_PREFIX + d.replace(/\./g, '\\.') + '[/:]';
      for (const r of rules.slice()) {
        if (r.action.type !== 'block') continue;
        const trigger = { ...r.trigger, 'url-filter': re };
        delete trigger['url-filter-is-case-sensitive'];
        rules.push({ trigger, action: { type: 'ignore-previous-rules' } });
      }
    }
  }

  let section;
  if (f.exception) section = f.important ? 'importantExceptions' : 'networkExceptions';
  else section = f.important ? 'important' : 'network';
  return { rules, section };
}
