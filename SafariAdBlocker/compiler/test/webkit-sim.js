// A small simulator of WebKit content-rule semantics for tests:
// evaluates rules top to bottom; `ignore-previous-rules` discards every
// action collected so far. Also performs the structural checks Safari makes
// when compiling a rule list.

import { validateWebKitRegex } from '../src/pattern.js';

const RESOURCE_TYPES = new Set(['document', 'image', 'style-sheet', 'script', 'font', 'raw', 'svg-document', 'media', 'popup', 'ping']);
const ACTIONS = new Set(['block', 'block-cookies', 'css-display-none', 'ignore-previous-rules', 'make-https']);
const TRIGGER_KEYS = new Set(['url-filter', 'url-filter-is-case-sensitive', 'if-domain', 'unless-domain', 'resource-type', 'load-type', 'load-context', 'if-top-url', 'unless-top-url']);

/** Throws on anything Safari would reject. */
export function assertValidRuleList(rules) {
  if (!Array.isArray(rules)) throw new Error('rule list must be an array');
  if (rules.length > 150000) throw new Error('more than 150000 rules: ' + rules.length);
  rules.forEach((r, i) => {
    const where = `rule #${i} ${JSON.stringify(r).slice(0, 200)}`;
    if (!r.trigger || !r.action) throw new Error('missing trigger/action: ' + where);
    for (const k of Object.keys(r.trigger)) if (!TRIGGER_KEYS.has(k)) throw new Error('unknown trigger key ' + k + ': ' + where);
    const re = r.trigger['url-filter'];
    const problem = validateWebKitRegex(re);
    if (problem) throw new Error('invalid url-filter (' + problem + '): ' + where);
    try {
      new RegExp(re);
    } catch (e) {
      throw new Error('url-filter is not even a JS regex: ' + where);
    }
    const conds = ['if-domain', 'unless-domain', 'if-top-url', 'unless-top-url'].filter((k) => k in r.trigger);
    if (conds.length > 1) throw new Error('multiple conditions: ' + where);
    for (const k of ['if-domain', 'unless-domain']) {
      if (!(k in r.trigger)) continue;
      const v = r.trigger[k];
      if (!Array.isArray(v) || v.length === 0) throw new Error(k + ' must be a non-empty array: ' + where);
      for (const d of v) {
        if (d !== d.toLowerCase()) throw new Error('domain must be lowercase: ' + where);
        // eslint-disable-next-line no-control-regex
        if (/[^\x21-\x7e]/.test(d)) throw new Error('domain must be ASCII: ' + where);
      }
    }
    if (r.trigger['resource-type']) {
      if (r.trigger['resource-type'].length === 0) throw new Error('empty resource-type: ' + where);
      for (const t of r.trigger['resource-type']) if (!RESOURCE_TYPES.has(t)) throw new Error('bad resource-type ' + t + ': ' + where);
    }
    if (r.trigger['load-type']) for (const t of r.trigger['load-type']) if (!['first-party', 'third-party'].includes(t)) throw new Error('bad load-type: ' + where);
    if (r.trigger['load-context']) for (const t of r.trigger['load-context']) if (!['top-frame', 'child-frame'].includes(t)) throw new Error('bad load-context: ' + where);
    if (!ACTIONS.has(r.action.type)) throw new Error('bad action: ' + where);
    if (r.action.type === 'css-display-none' && !r.action.selector) throw new Error('css-display-none without selector: ' + where);
  });
  if (rules.some((r) => 'if-top-url' in r.trigger || 'unless-top-url' in r.trigger) && rules.some((r) => 'if-domain' in r.trigger || 'unless-domain' in r.trigger)) {
    throw new Error('list mixes domain and top-url conditions');
  }
}

function hostOf(url) {
  return new URL(url).hostname;
}

function registrable(host) {
  const parts = host.split('.');
  return parts.slice(-2).join('.');
}

function domainMatches(patterns, host) {
  return patterns.some((p) => {
    if (p.startsWith('*')) {
      const d = p.slice(1);
      return host === d || host.endsWith('.' + d);
    }
    return host === p;
  });
}

const regexCache = new Map();

/**
 * @param {object[]} rules
 * @param {{url:string, type:string, page:string, frame?:'top-frame'|'child-frame'}} req
 * @returns {{blocked:boolean, actions:object[]}}
 */
export function evaluate(rules, req) {
  const pageHost = hostOf(req.page);
  const reqHost = hostOf(req.url);
  const thirdParty = registrable(pageHost) !== registrable(reqHost);
  const frame = req.frame || 'top-frame';
  let actions = [];
  for (const r of rules) {
    const t = r.trigger;
    const key = t['url-filter'] + (t['url-filter-is-case-sensitive'] ? '' : 'i');
    let re = regexCache.get(key);
    if (!re) regexCache.set(key, (re = new RegExp(t['url-filter'], t['url-filter-is-case-sensitive'] ? '' : 'i')));
    if (!re.test(req.url)) continue;
    if (t['resource-type'] && !t['resource-type'].includes(req.type)) continue;
    if (t['load-type'] && !t['load-type'].includes(thirdParty ? 'third-party' : 'first-party')) continue;
    if (t['load-context'] && !t['load-context'].includes(frame)) continue;
    if (t['if-domain'] && !domainMatches(t['if-domain'], pageHost)) continue;
    if (t['unless-domain'] && domainMatches(t['unless-domain'], pageHost)) continue;
    if (r.action.type === 'ignore-previous-rules') actions = [];
    else actions.push(r.action);
  }
  return { blocked: actions.some((a) => a.type === 'block'), actions };
}

/** Selectors Safari would hide on a page (document load). */
export function hiddenSelectors(rules, page) {
  const { actions } = evaluate(rules, { url: page, type: 'document', page });
  return actions.filter((a) => a.type === 'css-display-none').flatMap((a) => a.selector.split(', '));
}
