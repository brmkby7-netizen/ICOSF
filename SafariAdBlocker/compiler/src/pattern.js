// Converts ABP-style URL patterns and JavaScript regular expressions into the
// restricted regex dialect accepted by WebKit content rules (`url-filter`).
//
// WebKit supports: literals, `.`, character classes ([a-z], [^/]), groups,
// the quantifiers `*`, `+`, `?` (on atoms and groups), `^` only at the very
// start and `$` only at the very end. It rejects disjunctions (`|`), counted
// quantifiers, back references, lookarounds, word boundaries and non-ASCII.
// A single invalid url-filter makes Safari reject the whole rule list, so
// everything produced here is re-checked by `validateWebKitRegex`.

import { toASCII } from './domains.js';

export const HOST_PREFIX = '^[^:]+://+([^:/]+\\.)?';
const SEPARATOR = '[^a-zA-Z0-9_.%-]';
const REGEX_SPECIAL = new Set(['.', '+', '?', '$', '{', '}', '(', ')', '[', ']', '\\', '|', '^', '*']);
const HOST_TERMINATORS = new Set(['/', '^', '*', ':', '?', '|', '$', '&', '=']);

export class PatternError extends Error {}

function escapeLiteral(c) {
  if (REGEX_SPECIAL.has(c)) return '\\' + c;
  const code = c.charCodeAt(0);
  if (code > 0x7e || code < 0x20) {
    // URLs reach the matcher percent-encoded.
    return Array.from(new TextEncoder().encode(c))
      .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join('');
  }
  return c;
}

/**
 * ABP pattern -> WebKit regex.
 * Returns { regex, host } where `host` is set when the pattern is a pure
 * hostname anchor such as `||ads.example.com^` (used for strict blocking).
 */
export function abpPatternToRegex(pattern) {
  let p = pattern;
  let out = '';
  let i = 0;
  let inHost = false;
  let host = null;

  if (p.startsWith('||')) {
    i = 2;
    // Normalize the host part (lowercase + punycode).
    let j = i;
    while (j < p.length && !HOST_TERMINATORS.has(p[j])) j++;
    const rawHost = p.slice(i, j);
    if (rawHost) {
      const asciiHost = toASCII(rawHost);
      p = p.slice(0, i) + asciiHost + p.slice(j);
      const rest = p.slice(i + asciiHost.length);
      if ((rest === '' || rest === '^' || rest === '^|') && /^[a-z0-9.-]+$/.test(asciiHost) && asciiHost.includes('.')) {
        host = asciiHost.replace(/^\.+|\.+$/g, '');
      }
    }
    out = HOST_PREFIX;
    inHost = true;
  } else if (p.startsWith('|')) {
    i = 1;
    out = '^';
  }

  let end = p.length;
  let anchoredEnd = false;
  if (end > i && p[end - 1] === '|' && p[end - 2] !== '\\') {
    anchoredEnd = true;
    end--;
  }

  for (; i < end; i++) {
    const c = p[i];
    if (c === '*') {
      if (!out.endsWith('.*')) out += '.*';
      inHost = false;
    } else if (c === '^') {
      const atEnd = i === end - 1;
      if (inHost && out !== HOST_PREFIX) {
        // A host is always followed by a port or a path in a normalized URL.
        out += '[/:]';
      } else if (atEnd && !anchoredEnd) {
        out += '(' + SEPARATOR + '.*)?$';
        anchoredEnd = false;
        // Pattern is now explicitly anchored; nothing else may follow.
        return finish(out, host, true);
      } else if (atEnd && anchoredEnd) {
        out += SEPARATOR + '?';
      } else {
        out += SEPARATOR;
      }
      inHost = false;
    } else {
      if (c === '/' || c === ':' || c === '?') inHost = false;
      out += escapeLiteral(c);
    }
  }
  if (anchoredEnd) out += '$';
  return finish(out, host, anchoredEnd);
}

function finish(out, host, anchoredEnd) {
  if (!anchoredEnd) {
    while (out.endsWith('.*') && !out.endsWith('\\.*')) out = out.slice(0, -2);
  }
  while (out.startsWith('.*')) out = out.slice(2);
  if (out === '' || out === '^') out = '.*';
  return { regex: out, host };
}

// ---------------------------------------------------------------------------
// JavaScript regex -> WebKit regex(es)
// ---------------------------------------------------------------------------

const MAX_ALTERNATIVES = 12;
const MAX_REPEAT = 12;

function parseRegex(src) {
  let pos = 0;

  function parseAlternation(depth) {
    const alternatives = [parseSequence(depth)];
    while (src[pos] === '|') {
      pos++;
      alternatives.push(parseSequence(depth));
    }
    return { type: 'alt', alternatives };
  }

  function parseSequence(depth) {
    const items = [];
    while (pos < src.length && src[pos] !== '|' && !(src[pos] === ')' && depth > 0)) {
      const atom = parseAtom(depth);
      const quant = parseQuantifier();
      items.push({ atom, quant });
    }
    return items;
  }

  function parseQuantifier() {
    const c = src[pos];
    let quant = null;
    if (c === '*' || c === '+' || c === '?') {
      quant = { min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
      pos++;
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(pos));
      if (!m) throw new PatternError('bad counted quantifier');
      const min = parseInt(m[1], 10);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : parseInt(m[3], 10);
      if (max < min) throw new PatternError('bad counted quantifier');
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        // WebKit has no counted quantifiers and long expansions bloat the
        // DFA. Approximate with an open-ended repetition (slightly broader).
        quant = { min: Math.min(min, MAX_REPEAT), max: Infinity };
      } else {
        quant = { min, max };
      }
      pos += m[0].length;
    }
    if (quant && src[pos] === '?') pos++; // lazy quantifiers behave the same for matching
    return quant;
  }

  function parseClass() {
    // pos is at '['
    let out = '[';
    pos++;
    if (src[pos] === '^') {
      out += '^';
      pos++;
    }
    let first = true;
    while (pos < src.length && (src[pos] !== ']' || first)) {
      first = false;
      const c = src[pos];
      if (c === '\\') {
        const e = src[pos + 1];
        pos += 2;
        if (e === 'd') out += '0-9';
        else if (e === 'w') out += 'a-zA-Z0-9_';
        else if (e === '/' || e === '.' || e === '?' || e === '=' || e === '&' || e === ':' || e === '%' || e === ',' || e === '_' || e === '#' || e === '!' || e === '@' || e === '+' || e === '*' || e === '$' || e === '(' || e === ')' || e === '|' || e === '{' || e === '}' || e === ';' || e === '~' || e === "'" || e === '"') out += e === '\\' ? '\\\\' : e;
        else if (e === '-' || e === ']' || e === '[' || e === '^' || e === '\\') out += '\\' + e;
        else throw new PatternError('unsupported escape in class: \\' + e);
      } else {
        if (c.charCodeAt(0) > 0x7e) throw new PatternError('non-ASCII');
        out += c;
        pos++;
      }
    }
    if (src[pos] !== ']') throw new PatternError('unterminated class');
    pos++;
    return { type: 'lit', text: out + ']' };
  }

  function parseAtom(depth) {
    const c = src[pos];
    if (c === '(') {
      pos++;
      if (src[pos] === '?') {
        if (src[pos + 1] === ':') pos += 2;
        else throw new PatternError('lookaround/named groups unsupported');
      }
      const inner = parseAlternation(depth + 1);
      if (src[pos] !== ')') throw new PatternError('unbalanced group');
      pos++;
      return { type: 'group', inner };
    }
    if (c === '[') return parseClass();
    if (c === '\\') {
      const e = src[pos + 1];
      pos += 2;
      if (e === undefined) throw new PatternError('trailing backslash');
      if (e === 'd') return { type: 'lit', text: '[0-9]' };
      if (e === 'D') return { type: 'lit', text: '[^0-9]' };
      if (e === 'w') return { type: 'lit', text: '[a-zA-Z0-9_]' };
      if (e === 'W') return { type: 'lit', text: '[^a-zA-Z0-9_]' };
      if (/[0-9bBsSnrtfvuxcpPk]/.test(e)) throw new PatternError('unsupported escape \\' + e);
      if (e === '/' || e === '-' || e === '=' || e === '&' || e === ':' || e === '%' || e === ',' || e === '_' || e === '#' || e === '!' || e === '@' || e === ';' || e === '~' || e === '"' || e === "'") {
        return { type: 'lit', text: e };
      }
      return { type: 'lit', text: '\\' + e };
    }
    if (c === '^') {
      pos++;
      return { type: 'start' };
    }
    if (c === '$') {
      pos++;
      return { type: 'end' };
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') throw new PatternError('dangling quantifier');
    if (c.charCodeAt(0) > 0x7e || c.charCodeAt(0) < 0x20) throw new PatternError('non-ASCII');
    pos++;
    if (c === '.') return { type: 'lit', text: '.' };
    if (c === '}' || c === ']') return { type: 'lit', text: '\\' + c };
    return { type: 'lit', text: c };
  }

  const ast = parseAlternation(0);
  if (pos !== src.length) throw new PatternError('unexpected ' + src[pos]);
  return ast;
}

function cross(a, b) {
  const out = [];
  for (const x of a) for (const y of b) {
    out.push(x + y);
    if (out.length > MAX_ALTERNATIVES) throw new PatternError('too many alternatives');
  }
  return out;
}

function renderAlt(node) {
  const out = [];
  for (const seq of node.alternatives) {
    for (const s of renderSeq(seq)) {
      out.push(s);
      if (out.length > MAX_ALTERNATIVES) throw new PatternError('too many alternatives');
    }
  }
  return out;
}

function renderSeq(items) {
  let acc = [''];
  for (const { atom, quant } of items) {
    let variants;
    let single; // atom rendered as a single regex unit, when possible
    if (atom.type === 'lit') single = atom.text;
    else if (atom.type === 'start') {
      if (quant) throw new PatternError('quantified anchor');
      single = '^';
    } else if (atom.type === 'end') {
      if (quant) throw new PatternError('quantified anchor');
      single = '$';
    } else {
      const inner = renderAlt(atom.inner);
      // Without a quantifier a group is plain concatenation: drop the parens so
      // anchors such as `(^|\.)` can expand to a leading `^`.
      if (!quant || (quant.min === 1 && quant.max === 1)) variants = inner;
      else if (inner.length === 1) single = '(' + inner[0] + ')';
      else variants = inner;
    }

    if (single !== undefined) {
      variants = [applyQuant(single, quant)];
    } else if (quant && !(quant.min === 1 && quant.max === 1)) {
      // (a|b)? expands to "", "a", "b".
      if (quant.min === 0 && quant.max === 1) variants = ['', ...variants];
      else throw new PatternError('quantified disjunction');
    }
    acc = cross(acc, variants);
  }
  return acc;
}

function applyQuant(unit, quant) {
  if (!quant) return unit;
  const { min, max } = quant;
  if (min === 0 && max === Infinity) return unit + '*';
  if (min === 1 && max === Infinity) return unit + '+';
  if (min === 0 && max === 1) return unit + '?';
  if (min === 1 && max === 1) return unit;
  let s = unit.repeat(Math.max(0, min - 1));
  if (max === Infinity) return s + (min === 0 ? unit + '*' : unit + '+');
  if (min > 0) s += unit;
  for (let k = min; k < max; k++) s += unit + '?';
  return s;
}

/** Returns an array of WebKit-compatible regexes equivalent to the JS regex. */
export function jsRegexToWebKit(source) {
  const ast = parseRegex(source);
  const variants = renderAlt(ast);
  const out = [];
  for (let v of variants) {
    // Anchors must be at the very ends.
    const inner = v.replace(/^\^/, '').replace(/(?<!\\)\$$/, '');
    if (/(^|[^\\])\^/.test(inner.replace(/\[\^/g, '[')) || /(^|[^\\])\$/.test(inner)) {
      throw new PatternError('anchor in the middle');
    }
    while (v.startsWith('.*')) v = v.slice(2);
    if (v === '' || v === '^') v = '.*';
    out.push(v);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Validator mirroring WebKit's URLFilterParser restrictions.
// ---------------------------------------------------------------------------

export function validateWebKitRegex(re) {
  if (typeof re !== 'string' || re.length === 0) return 'empty';
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7E]/.test(re)) return 'non-ASCII';
  let depth = 0;
  let inClass = false;
  let prevQuantifiable = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') {
      const e = re[i + 1];
      if (e === undefined) return 'trailing backslash';
      if (/[0-9a-zA-Z]/.test(e)) return 'unsupported escape \\' + e;
      i++;
      prevQuantifiable = !inClass;
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
        prevQuantifiable = true;
      }
      continue;
    }
    switch (c) {
      case '[':
        inClass = true;
        if (re[i + 1] === '^') i++;
        if (re[i + 1] === ']') i++; // literal ] as first char
        break;
      case '(':
        if (re[i + 1] === '?') return 'group modifiers unsupported';
        depth++;
        prevQuantifiable = false;
        break;
      case ')':
        if (depth === 0) return 'unbalanced )';
        depth--;
        prevQuantifiable = true;
        break;
      case '|':
        return 'disjunction';
      case '{':
      case '}':
        return 'counted quantifier';
      case '*':
      case '+':
      case '?':
        if (!prevQuantifiable) return 'quantifier without atom';
        prevQuantifiable = false;
        break;
      case '^':
        if (i !== 0) return '^ not at start';
        prevQuantifiable = false;
        break;
      case '$':
        if (i !== re.length - 1) return '$ not at end';
        prevQuantifiable = false;
        break;
      default:
        prevQuantifiable = true;
    }
  }
  if (inClass) return 'unterminated class';
  if (depth !== 0) return 'unbalanced (';
  return null;
}
