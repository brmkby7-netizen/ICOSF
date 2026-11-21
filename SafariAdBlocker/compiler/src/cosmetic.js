// Cosmetic filter parsing: element hiding, extended/procedural selectors,
// CSS injection and scriptlets (uBO `+js()`, AdGuard `//scriptlet()`, ABP
// snippets).

import { parseDomainList } from './domains.js';

const SEPARATOR_RE = /#(@)?(\$\?|\$|\?|%)?#/;

// Pseudo-classes that are not native CSS and need the extension's engine.
const EXTENDED_PSEUDOS = [
  ':has-text(', ':contains(', ':-abp-contains(', ':-abp-has(', ':-abp-properties(', ':matches-css(',
  ':matches-css-before(', ':matches-css-after(', ':matches-attr(', ':matches-path(', ':matches-prop(',
  ':matches-property(', ':min-text-length(', ':nth-ancestor(', ':upward(', ':xpath(', ':remove(',
  ':style(', ':watch-attr(', ':watch-attrs(', ':if(', ':if-not(', ':others(', ':remove-attr(',
  ':remove-class(', ':shadow(', ':matches-media(', ':-ext-',
];

export function isExtendedSelector(selector) {
  for (const p of EXTENDED_PSEUDOS) if (selector.includes(p)) return true;
  // `:has()` is native in Safari 15.4+, but nesting `:has()` inside `:has()`
  // is invalid CSS; the extension's engine handles those.
  return hasNestedHas(selector);
}

function hasNestedHas(selector) {
  let idx = selector.indexOf(':has(');
  while (idx !== -1) {
    let depth = 0;
    for (let i = idx + 4; i < selector.length; i++) {
      if (selector[i] === '(') depth++;
      else if (selector[i] === ')' && --depth === 0) break;
      else if (depth > 0 && selector.startsWith(':has(', i)) return true;
    }
    idx = selector.indexOf(':has(', idx + 5);
  }
  return false;
}

/** Cheap structural check: balanced brackets/quotes, no rule-breaking chars. */
export function isPlausibleSelector(selector) {
  if (!selector || selector.length > 2000) return false;
  if (/[{}]/.test(selector)) return false;
  if (/^\s*[>+~,]/.test(selector)) return false;
  let paren = 0, bracket = 0, quote = null;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '(') paren++;
    else if (c === ')') { if (--paren < 0) return false; }
    else if (c === '[') bracket++;
    else if (c === ']') { if (--bracket < 0) return false; }
  }
  return paren === 0 && bracket === 0 && quote === null;
}

/**
 * Splits a cosmetic filter. Returns null when the line is not cosmetic.
 * kind: 'hide' | 'extended' | 'css' | 'scriptlet' | 'js' | 'html'
 */
export function parseCosmeticFilter(line) {
  if (line.startsWith('[$')) return { unsupported: 'AdGuard [$modifiers]' };
  const m = SEPARATOR_RE.exec(line);
  if (!m) return null;
  const domainPart = line.slice(0, m.index);
  // Domain lists never contain these; if they do this is a URL with a `#`.
  if (/[/\s|^$@?=&]/.test(domainPart) && !domainPart.startsWith('/')) return null;
  const exception = m[1] === '@';
  const marker = m[2] || '';
  let body = line.slice(m.index + m[0].length);

  const domains = parseDomainList(domainPart, ',');
  const base = { raw: line, exception, domains, body };

  if (domains.unsupported.length && domains.include.length === 0 && domains.exclude.length === 0) {
    return { ...base, unsupported: 'domain entities only' };
  }
  // Entity-only positives (example.*) would otherwise turn into a generic rule.
  if (domains.unsupported.some((d) => !d.startsWith('~')) && domains.include.length === 0) {
    return { ...base, unsupported: 'domain entities only' };
  }

  if (marker === '%') {
    const s = parseAdGuardScriptlet(body);
    if (s) return { ...base, kind: 'scriptlet', scriptlet: s };
    return { ...base, kind: 'js', unsupported: 'raw JavaScript injection' };
  }
  if (marker === '$' || marker === '$?') {
    // CSS injection, or an ABP snippet when there are no braces.
    const css = /^(.+?)\s*\{\s*(.*)\s*\}\s*$/s.exec(body);
    if (css) {
      return { ...base, kind: 'css', selector: css[1].trim(), style: css[2].trim(), extended: marker === '$?' || isExtendedSelector(css[1]) };
    }
    const snippets = parseAbpSnippets(body);
    if (snippets.length) return { ...base, kind: 'scriptlet', scriptlet: snippets[0], extraScriptlets: snippets.slice(1) };
    return { ...base, unsupported: 'unrecognized #$# body' };
  }
  if (body.startsWith('^')) return { ...base, kind: 'html', unsupported: 'HTML filtering' };
  if (body.startsWith('+js(')) {
    const s = parseUboScriptlet(body);
    if (!s) return { ...base, unsupported: 'malformed +js()' };
    return { ...base, kind: 'scriptlet', scriptlet: s };
  }
  if (marker === '?') {
    return { ...base, kind: 'extended', selector: body.trim() };
  }
  const selector = body.trim();
  if (!selector) return { ...base, unsupported: 'empty selector' };
  // uBO-style `:style()` / `:remove()` on plain `##`.
  const styleMatch = /^(.*):style\((.*)\)$/s.exec(selector);
  if (styleMatch && !isExtendedSelector(styleMatch[1])) {
    return { ...base, kind: 'css', selector: styleMatch[1], style: styleMatch[2], extended: false };
  }
  if (isExtendedSelector(selector)) return { ...base, kind: 'extended', selector };
  return { ...base, kind: 'hide', selector };
}

// ---------------------------------------------------------------------------
// Scriptlets
// ---------------------------------------------------------------------------

/** Splits `a, 'b, c', /d,e/` respecting quotes, regex literals and `\,`. */
export function splitScriptletArgs(text) {
  const args = [];
  let cur = '';
  let quote = null;
  let i = 0;
  let atStart = true;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && text[i + 1] === quote) {
        cur += quote;
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (atStart && (c === '"' || c === "'" || c === '`') && cur.trim() === '') {
      quote = c;
      cur = '';
      atStart = false;
      i++;
      continue;
    }
    if (c === '\\' && text[i + 1] === ',') {
      cur += ',';
      i += 2;
      atStart = false;
      continue;
    }
    if (c === ',') {
      args.push(cur.trim());
      cur = '';
      atStart = true;
      i++;
      continue;
    }
    if (c !== ' ' || cur !== '') atStart = false;
    cur += c;
    i++;
  }
  if (cur.trim() !== '' || args.length) args.push(cur.trim());
  return args;
}

function parseUboScriptlet(body) {
  if (!body.endsWith(')')) return null;
  const inner = body.slice(4, -1);
  if (inner.trim() === '') return { name: '', args: [] }; // `#@#+js()` disables all
  const parts = splitScriptletArgs(inner);
  const name = normalizeScriptletName(parts[0]);
  return { name, args: parts.slice(1) };
}

function parseAdGuardScriptlet(body) {
  const m = /^\/\/scriptlet\((.*)\)\s*;?$/s.exec(body.trim());
  if (!m) return null;
  if (m[1].trim() === '') return { name: '', args: [] };
  const parts = splitScriptletArgs(m[1]);
  return { name: normalizeScriptletName(parts[0]), args: parts.slice(1) };
}

const ABP_SNIPPET_MAP = {
  'abort-on-property-read': 'abort-on-property-read',
  'abort-on-property-write': 'abort-on-property-write',
  'abort-current-inline-script': 'abort-current-script',
  'abort-on-iframe-property-read': null,
  'json-prune': 'json-prune',
  'override-property-read': 'set-constant',
  'prevent-listener': 'prevent-addEventListener',
  'strip-fetch-query-parameter': null,
  'hide-if-contains': 'hide-if-contains',
  'hide-if-contains-visible-text': 'hide-if-contains',
  'hide-if-contains-and-matches-style': 'hide-if-contains',
  'hide-if-has-and-matches-style': null,
  'remove-attr': 'remove-attr',
  'remove-class': 'remove-class',
  'cookie-remover': 'remove-cookie',
};

function parseAbpSnippets(body) {
  const out = [];
  for (const part of body.split(/;\s*/)) {
    const tokens = part.trim().match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\S+/g);
    if (!tokens || tokens.length === 0) continue;
    const mapped = ABP_SNIPPET_MAP[tokens[0]];
    if (!mapped) return [];
    out.push({ name: mapped, args: tokens.slice(1).map((t) => t.replace(/^(['"])(.*)\1$/, '$2')) });
  }
  return out;
}

// Aliases from uBO, AdGuard and ABP to the canonical names implemented in
// extension/scriptlets.js.
const SCRIPTLET_ALIASES = {
  'set': 'set-constant',
  'set-constant': 'set-constant',
  'trusted-set-constant': 'set-constant',
  'trusted-set': 'set-constant',
  'aopr': 'abort-on-property-read',
  'abort-on-property-read': 'abort-on-property-read',
  'aopw': 'abort-on-property-write',
  'abort-on-property-write': 'abort-on-property-write',
  'acs': 'abort-current-script',
  'acis': 'abort-current-script',
  'abort-current-script': 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script',
  'aost': 'abort-on-stack-trace',
  'abort-on-stack-trace': 'abort-on-stack-trace',
  'json-prune': 'json-prune',
  'json-prune-fetch-response': 'json-prune-fetch-response',
  'json-prune-xhr-response': 'json-prune-xhr-response',
  'trusted-replace-fetch-response': 'replace-fetch-response',
  'trusted-rpfr': 'replace-fetch-response',
  'trusted-replace-xhr-response': 'replace-xhr-response',
  'trusted-rpxr': 'replace-xhr-response',
  'nostif': 'prevent-setTimeout',
  'no-setTimeout-if': 'prevent-setTimeout',
  'setTimeout-defuser': 'prevent-setTimeout',
  'prevent-setTimeout': 'prevent-setTimeout',
  'nosiif': 'prevent-setInterval',
  'no-setInterval-if': 'prevent-setInterval',
  'setInterval-defuser': 'prevent-setInterval',
  'prevent-setInterval': 'prevent-setInterval',
  'nano-stb': 'adjust-setTimeout',
  'nano-setTimeout-booster': 'adjust-setTimeout',
  'adjust-setTimeout': 'adjust-setTimeout',
  'nano-sib': 'adjust-setInterval',
  'nano-setInterval-booster': 'adjust-setInterval',
  'adjust-setInterval': 'adjust-setInterval',
  'aeld': 'prevent-addEventListener',
  'addEventListener-defuser': 'prevent-addEventListener',
  'prevent-addEventListener': 'prevent-addEventListener',
  'no-fetch-if': 'prevent-fetch',
  'prevent-fetch': 'prevent-fetch',
  'no-xhr-if': 'prevent-xhr',
  'prevent-xhr': 'prevent-xhr',
  'ra': 'remove-attr',
  'remove-attr': 'remove-attr',
  'rc': 'remove-class',
  'remove-class': 'remove-class',
  'set-attr': 'set-attr',
  'trusted-set-attr': 'set-attr',
  'set-cookie': 'set-cookie',
  'trusted-set-cookie': 'set-cookie',
  'cookie-remover': 'remove-cookie',
  'remove-cookie': 'remove-cookie',
  'set-local-storage-item': 'set-local-storage-item',
  'trusted-set-local-storage-item': 'set-local-storage-item',
  'set-session-storage-item': 'set-session-storage-item',
  'trusted-set-session-storage-item': 'set-session-storage-item',
  'nowoif': 'prevent-window-open',
  'no-window-open-if': 'prevent-window-open',
  'window.open-defuser': 'prevent-window-open',
  'prevent-window-open': 'prevent-window-open',
  'noeval-if': 'prevent-eval-if',
  'prevent-eval-if': 'prevent-eval-if',
  'noeval': 'prevent-eval-if',
  'norafif': 'prevent-requestAnimationFrame',
  'no-requestAnimationFrame-if': 'prevent-requestAnimationFrame',
  'prevent-requestAnimationFrame': 'prevent-requestAnimationFrame',
  'refresh-defuser': 'prevent-refresh',
  'prevent-refresh': 'prevent-refresh',
  'nowebrtc': 'nowebrtc',
  'disable-newtab-links': 'disable-newtab-links',
  'close-window': 'close-window',
  'window-close-if': 'close-window',
  'rmnt': 'remove-node-text',
  'remove-node-text': 'remove-node-text',
  'rpnt': 'replace-node-text',
  'trusted-rpnt': 'replace-node-text',
  'replace-node-text': 'replace-node-text',
  'trusted-replace-node-text': 'replace-node-text',
  'set-cookie-reload': 'set-cookie-reload',
  'trusted-set-cookie-reload': 'set-cookie-reload',
  'prevent-element-src-loading': 'prevent-element-src-loading',
  'href-sanitizer': 'href-sanitizer',
  'no-floc': 'no-topics',
  'no-topics': 'no-topics',
  'hide-if-contains': 'hide-if-contains',
  'trusted-click-element': 'click-element',
  'click-element': 'click-element',
  'log': 'log',
};

export function normalizeScriptletName(raw) {
  let name = (raw || '').trim().replace(/^['"`]|['"`]$/g, '');
  name = name.replace(/^ubo-/, '').replace(/\.js$/, '');
  return SCRIPTLET_ALIASES[name] || name;
}

export function isSupportedScriptlet(name) {
  return name === '' || Object.values(SCRIPTLET_ALIASES).includes(name);
}
