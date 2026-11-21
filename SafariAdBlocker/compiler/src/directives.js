// Preprocessor directives used by filter lists:
//   !#if <expr> / !#else / !#endif   (uBO + AdGuard)
//   !#safari_cb_affinity(name, ...) / !#safari_cb_affinity   (AdGuard)

// Environment Bastion presents to `!#if` conditions. We understand both uBO
// and AdGuard syntax, but we are a Safari content blocker without HTML
// filtering, so declare exactly that.
export const DEFAULT_ENV = {
  // AdGuard
  adguard: true,
  adguard_ext_safari: true,
  adguard_app_ios: false,
  adguard_app_mac: false,
  adguard_ext_chromium: false,
  adguard_ext_chromium_mv3: false,
  adguard_ext_firefox: false,
  adguard_ext_edge: false,
  adguard_ext_opera: false,
  adguard_ext_android_cb: false,
  adguard_app_windows: false,
  adguard_app_android: false,
  ext_safari: true,
  ext_ublock: false,
  // uBO
  env_safari: true,
  env_chromium: false,
  env_firefox: false,
  env_edge: false,
  env_mobile: false,
  env_mv3: false,
  cap_html_filtering: false,
  cap_user_stylesheet: true,
  cap_ipaddress: false,
  false: false,
  true: true,
};

/** Evaluates `!#if` expressions: identifiers, !, &&, ||, parentheses. */
export function evaluateCondition(expr, env = DEFAULT_ENV) {
  const tokens = expr.match(/\(|\)|!|&&|\|\||[A-Za-z0-9_]+/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let v = parseAnd();
    while (peek() === '||') {
      next();
      const r = parseAnd();
      v = v || r;
    }
    return v;
  }
  function parseAnd() {
    let v = parseUnary();
    while (peek() === '&&') {
      next();
      const r = parseUnary();
      v = v && r;
    }
    return v;
  }
  function parseUnary() {
    const t = next();
    if (t === '!') return !parseUnary();
    if (t === '(') {
      const v = parseOr();
      if (peek() === ')') next();
      return v;
    }
    if (t === undefined) return false;
    return Boolean(env[t]);
  }
  try {
    return parseOr();
  } catch {
    return false;
  }
}

const AFFINITY_MAP = {
  general: 'ads',
  privacy: 'privacy',
  social: 'social',
  security: 'security',
  other: 'annoyances',
  custom: 'custom',
  all: 'all',
};

/**
 * Iterates filter lines, honoring directives. Yields { line, affinity }.
 */
export function* preprocess(text, env = DEFAULT_ENV) {
  const stack = []; // each: { active, parentActive, taken }
  let affinity = null;
  const isActive = () => stack.every((s) => s.active);
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    line = line.trim();
    if (!line) continue;

    if (line.startsWith('!#')) {
      const d = line.slice(2);
      if (d.startsWith('if')) {
        const expr = d.slice(2).trim();
        stack.push({ active: evaluateCondition(expr, env) });
      } else if (d.startsWith('else')) {
        if (stack.length) stack[stack.length - 1].active = !stack[stack.length - 1].active;
      } else if (d.startsWith('endif')) {
        stack.pop();
      } else if (d.startsWith('safari_cb_affinity')) {
        const m = /^safari_cb_affinity\(([^)]*)\)/.exec(d);
        if (m) {
          const first = m[1].split(',').map((s) => s.trim()).find((s) => AFFINITY_MAP[s]);
          affinity = first ? AFFINITY_MAP[first] : null;
        } else {
          affinity = null;
        }
      }
      continue;
    }
    if (!isActive()) continue;
    if (line.startsWith('!') || line.startsWith('[')) {
      // Comments and "[Adblock Plus 2.0]" headers. AdGuard "[$...]" rules
      // start with "[$" and are reported as unsupported by the parser.
      if (!line.startsWith('[$')) continue;
    }
    if (line.startsWith('# ') || line === '#' || line.startsWith('####')) continue;
    yield { line, affinity };
  }
}
