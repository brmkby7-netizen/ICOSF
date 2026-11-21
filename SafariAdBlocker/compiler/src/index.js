// Public API of the Bastion filter compiler. Bundled by esbuild into
// `dist/bastion-compiler.js` (IIFE exposing `BastionCompiler`) for the apps,
// which run it inside a WKWebView, and imported directly by Node scripts.

import { compile, CATEGORIES, SECTION_ORDER } from './compile.js';
import { distribute, allowlistRules, DEFAULT_SLOTS, SAFARI_RULE_LIMIT } from './distribute.js';
import { buildWebIndex, shardWebIndex, lookupWebRules, lookupParts, candidateKeys, fnv1a } from './web.js';
import { validateWebKitRegex, abpPatternToRegex, jsRegexToWebKit } from './pattern.js';
import { parseNetworkFilter, convertNetworkFilter } from './network.js';
import { parseCosmeticFilter } from './cosmetic.js';

export const VERSION = '1.0.0';

/**
 * One-shot pipeline used by the apps and build scripts.
 * @returns {{ blockers: Record<string, object[]>, webIndex: object, report: object }}
 */
export function build(lists, options = {}) {
  const compiled = compile(lists, options);
  const { slots, report } = distribute(compiled, options);
  const webIndex = buildWebIndex(compiled.web);
  return {
    blockers: slots,
    webIndex,
    report: {
      version: VERSION,
      builtAt: new Date().toISOString(),
      durationMs: compiled.durationMs,
      stats: compiled.stats,
      distribution: report,
      errors: compiled.errors.slice(0, 50),
    },
  };
}

/** String-in/string-out wrapper for WKWebView/JavaScriptCore callers. */
export function buildJSON(listsJSON, optionsJSON) {
  const lists = JSON.parse(listsJSON);
  const options = optionsJSON ? JSON.parse(optionsJSON) : {};
  if (options.useDOMSelectorValidation && typeof document !== 'undefined') {
    const frag = document.createDocumentFragment();
    options.validateSelector = (sel) => {
      try {
        frag.querySelector(sel);
        return true;
      } catch {
        return false;
      }
    };
  }
  const out = build(lists, options);
  return {
    blockers: Object.fromEntries(Object.entries(out.blockers).map(([k, v]) => [k, asciiJSON(v)])),
    // ASCII-only so the native side can slice it at byte offsets.
    webIndex: asciiJSON(out.webIndex),
    report: JSON.stringify(out.report),
  };
}

/** JSON.stringify with every non-ASCII character escaped as \uXXXX. */
export function asciiJSON(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export {
  compile,
  distribute,
  allowlistRules,
  buildWebIndex,
  shardWebIndex,
  lookupWebRules,
  lookupParts,
  candidateKeys,
  fnv1a,
  validateWebKitRegex,
  abpPatternToRegex,
  jsRegexToWebKit,
  parseNetworkFilter,
  convertNetworkFilter,
  parseCosmeticFilter,
  CATEGORIES,
  SECTION_ORDER,
  DEFAULT_SLOTS,
  SAFARI_RULE_LIMIT,
};
