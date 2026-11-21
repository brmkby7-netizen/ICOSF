// Domain helpers: normalization, punycode (RFC 3492), and ABP domain lists.
// Kept dependency-free so the compiler runs unchanged in Node, JavaScriptCore
// and WKWebView.

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

function adapt(delta, numPoints, firstTime) {
  let k = 0;
  delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((BASE - TMIN) * TMAX) >> 1; k += BASE) {
    delta = Math.floor(delta / (BASE - TMIN));
  }
  return Math.floor(k + ((BASE - TMIN + 1) * delta) / (delta + SKEW));
}

function digitToBasic(d) {
  return d + 22 + 75 * (d < 26);
}

function punycodeEncodeLabel(label) {
  const input = Array.from(label).map((c) => c.codePointAt(0));
  let n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;
  let output = '';
  for (const c of input) if (c < 0x80) output += String.fromCharCode(c);
  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength) output += '-';
  while (handled < input.length) {
    let m = Infinity;
    for (const c of input) if (c >= n && c < m) m = c;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of input) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
          if (q < t) break;
          output += String.fromCharCode(digitToBasic(t + ((q - t) % (BASE - t))));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += String.fromCharCode(digitToBasic(q));
        bias = adapt(delta, handled + 1, handled === basicLength);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output;
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

export function toASCII(domain) {
  if (!NON_ASCII.test(domain)) return domain.toLowerCase();
  return domain
    .toLowerCase()
    .split('.')
    .map((label) => (NON_ASCII.test(label) ? 'xn--' + punycodeEncodeLabel(label) : label))
    .join('.');
}

// Used to expand uBO/AdGuard entity domains (example.*).
export const ENTITY_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'me', 'tv', 'cc', 'to', 'info', 'biz', 'xyz', 'top', 'site', 'online',
  'live', 'club', 'pro', 'app', 'one', 'us', 'uk', 'co.uk', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'ru',
  'br', 'com.br', 'in', 'jp', 'ca', 'au', 'com.au', 'se', 'ch', 'at', 'be', 'cz', 'pt', 'tr', 'mx', 'ws',
  'la', 'li', 'lol', 'sx', 'ac', 'is', 'nu', 'si', 'su',
];

const DOMAIN_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/;

/** Returns a normalized ASCII hostname or null when it is not a plain hostname. */
export function normalizeDomain(raw) {
  if (!raw) return null;
  let d = raw.trim();
  if (d.endsWith('.')) d = d.slice(0, -1);
  d = toASCII(d);
  if (!DOMAIN_RE.test(d)) return null;
  return d;
}

/**
 * Parses an ABP/uBO domain list ("a.com|~b.com" or "a.com,~b.com").
 * Entities ("example.*") and regex domains are not expressible in WebKit
 * content rules; they are reported in `unsupported` so callers can decide.
 */
export function parseDomainList(text, separator) {
  const include = [];
  const exclude = [];
  const unsupported = [];
  // Same lists with entities left as "example.*" (the web extension matches
  // those natively, so it does not need the TLD expansion).
  const includeRaw = [];
  const excludeRaw = [];
  if (!text) return { include, exclude, unsupported, includeRaw, excludeRaw };
  for (let part of text.split(separator)) {
    part = part.trim();
    if (!part) continue;
    let negated = false;
    if (part.startsWith('~')) {
      negated = true;
      part = part.slice(1);
    }
    if (part.endsWith('.*') && !part.slice(0, -2).includes('*')) {
      // Entity ("example.*"): WebKit has no TLD wildcard, so expand it to the
      // TLDs where such sites overwhelmingly live.
      const base = normalizeDomain(part.slice(0, -2));
      if (base) {
        for (const tld of ENTITY_TLDS) (negated ? exclude : include).push(base + '.' + tld);
        (negated ? excludeRaw : includeRaw).push(base + '.*');
        continue;
      }
    }
    if (part.startsWith('/') || part.includes('*')) {
      unsupported.push((negated ? '~' : '') + part);
      continue;
    }
    const d = normalizeDomain(part);
    if (!d) {
      unsupported.push((negated ? '~' : '') + part);
      continue;
    }
    (negated ? exclude : include).push(d);
    (negated ? excludeRaw : includeRaw).push(d);
  }
  return { include, exclude, unsupported, includeRaw, excludeRaw };
}

/** WebKit's if-domain/unless-domain syntax: "*example.com" matches subdomains too. */
export function toWebKitDomains(domains) {
  return [...new Set(domains)].sort().map((d) => '*' + d);
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function isSubdomainOf(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}
