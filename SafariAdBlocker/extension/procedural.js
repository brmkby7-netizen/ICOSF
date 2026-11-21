/*
 * Bastion procedural cosmetic engine.
 *
 * Evaluates extended selectors that CSS cannot express, e.g.
 *   div.post:has-text(/Sponsored|Promoted/)
 *   .card:-abp-has(.label:contains(Ad)):upward(2)
 *   :xpath(//div[@data-ad]) > span
 *   body > div:matches-css(position: fixed):remove()
 *   .overlay:style(display: none !important)
 *
 * Runs in the content script's isolated world (the DOM is shared).
 */
(function () {
  'use strict';

  const OPERATORS = new Set([
    'has-text', 'contains', '-abp-contains', '-abp-has', 'has', 'if', 'if-not', 'not', 'is',
    'matches-css', 'matches-css-before', 'matches-css-after', 'matches-attr', 'matches-path',
    'matches-media', 'min-text-length', 'upward', 'nth-ancestor', 'xpath', 'remove', 'style',
    'remove-attr', 'remove-class', 'watch-attr', 'watch-attrs', 'matches-prop', 'matches-property',
    // Recognized but unsupported: the whole selector is rejected.
    'others', 'shadow', '-abp-properties', 'spath',
  ]);
  // Operators that are native CSS when their argument is native CSS.
  const NATIVE_WHEN_PLAIN = new Set(['has', 'not', 'is']);
  const ACTIONS = new Set(['remove', 'style', 'remove-attr', 'remove-class']);

  function toRegex(text) {
    const m = /^\/(.*)\/([imsu]*)$/s.exec(text);
    if (m) {
      try { return new RegExp(m[1], m[2]); } catch { return null; }
    }
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  function unquote(s) {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }

  /** Reads a balanced (...) argument starting at `open`; returns [arg, endIndex]. */
  function readArg(s, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return [s.slice(open + 1, i), i + 1];
    }
    return null;
  }

  function containsOperator(s) {
    return findOperator(s, 0) !== null;
  }

  /** Finds the next procedural operator at bracket depth 0. */
  function findOperator(s, from) {
    let bracket = 0;
    let paren = 0;
    let quote = null;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '\\') { i++; continue; }
      if (c === '[') bracket++;
      else if (c === ']') bracket--;
      else if (c === '(') paren++;
      else if (c === ')') paren--;
      else if (c === ':' && bracket === 0 && paren === 0) {
        const m = /^:([-a-z]+)\(/.exec(s.slice(i));
        if (!m || !OPERATORS.has(m[1])) continue;
        const r = readArg(s, i + m[0].length - 1);
        if (!r) return null;
        const [arg, end] = r;
        // Native :has()/:not()/:is() stay CSS unless they wrap procedural
        // operators or nest :has() (invalid in CSS).
        if (NATIVE_WHEN_PLAIN.has(m[1]) && !containsOperator(arg) && !(m[1] === 'has' && arg.includes(':has('))) { i = end - 1; continue; }
        return { index: i, name: m[1], arg, end };
      }
    }
    return null;
  }

  /**
   * Compiles a selector to a list of tasks. Returns null for unsupported
   * syntax so a bad rule never hides the wrong things.
   */
  function compile(selector, relative) {
    const tasks = [];
    let pos = 0;
    let action = null;
    let watchAttrs = false;
    let first = true;
    const s = selector.trim();
    while (pos < s.length) {
      const op = findOperator(s, pos);
      let css = s.slice(pos, op ? op.index : s.length);
      if (css.trim() !== '' || (first && !op)) {
        if (/[>+~\s]$/.test(css) && op) css += '*';
        tasks.push({ type: first && !relative ? 'query' : 'spath', css: css.trim() === '' ? '*' : css });
      } else if (first && op && !['xpath', 'matches-path', 'matches-media'].includes(op.name)) {
        tasks.push({ type: first && !relative ? 'query' : 'spath', css: '*' });
      }
      first = false;
      if (!op) break;
      pos = op.end;
      const name = op.name;
      const arg = op.arg;
      if (ACTIONS.has(name)) {
        if (s.slice(pos).trim() !== '') return null; // actions must come last
        action = { type: name, arg };
        break;
      }
      switch (name) {
        case 'has-text':
        case 'contains':
        case '-abp-contains': {
          const re = toRegex(unquote(arg));
          if (!re) return null;
          tasks.push({ type: 'text', re });
          break;
        }
        case '-abp-has':
        case 'has':
        case 'if': {
          const sub = compile(arg, true);
          if (!sub) return null;
          tasks.push({ type: 'has', sub, negate: false });
          break;
        }
        case 'if-not':
        case 'not': {
          const sub = compile(arg, true);
          if (!sub) return null;
          tasks.push({ type: 'has', sub, negate: true, self: name === 'not' });
          break;
        }
        case 'is': {
          const alternatives = splitTopLevel(arg).map((a) => compile(a, true));
          if (alternatives.some((a) => !a)) return null;
          tasks.push({ type: 'is', alternatives });
          break;
        }
        case 'matches-css':
        case 'matches-css-before':
        case 'matches-css-after': {
          const m = /^\s*([-a-z]+)\s*:\s*(.*)$/is.exec(arg);
          if (!m) return null;
          const raw = m[2].trim();
          let re;
          if (raw.startsWith('/')) re = toRegex(raw);
          else re = new RegExp('^' + raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
          if (!re) return null;
          const pseudo = name === 'matches-css-before' ? '::before' : name === 'matches-css-after' ? '::after' : null;
          tasks.push({ type: 'css', prop: m[1], re, pseudo });
          break;
        }
        case 'matches-attr': {
          const m = /^\s*("[^"]*"|'[^']*'|\/[^/]+\/[a-z]*|[^=]+?)\s*(?:=\s*(.*))?$/s.exec(arg);
          if (!m) return null;
          const nameRe = toRegex(unquote(m[1]));
          const valueRe = m[2] === undefined ? null : toRegex(unquote(m[2]));
          if (!nameRe) return null;
          tasks.push({ type: 'attr', nameRe, valueRe });
          break;
        }
        case 'matches-prop':
        case 'matches-property': {
          const m = /^\s*([^=]+?)\s*(?:=\s*(.*))?$/s.exec(unquote(arg));
          if (!m) return null;
          tasks.push({ type: 'prop', chain: unquote(m[1]).split('.'), valueRe: m[2] === undefined ? null : toRegex(unquote(m[2])) });
          break;
        }
        case 'matches-path': {
          const re = toRegex(unquote(arg));
          if (!re) return null;
          tasks.push({ type: 'path', re });
          break;
        }
        case 'matches-media': {
          tasks.push({ type: 'media', query: arg });
          break;
        }
        case 'min-text-length': {
          const n = parseInt(arg, 10);
          if (!(n >= 0)) return null;
          tasks.push({ type: 'minlen', n });
          break;
        }
        case 'upward':
        case 'nth-ancestor': {
          const n = /^\s*\d+\s*$/.test(arg) ? parseInt(arg, 10) : null;
          if (n !== null && (n < 1 || n > 256)) return null;
          if (n === null && name === 'nth-ancestor') return null;
          tasks.push({ type: 'upward', n, sel: n === null ? arg : null });
          break;
        }
        case 'xpath':
          tasks.push({ type: 'xpath', expr: unquote(arg) });
          break;
        case 'watch-attr':
        case 'watch-attrs':
          watchAttrs = true;
          break;
        default:
          return null;
      }
    }
    if (tasks.length === 0) return null;
    return { tasks, action, watchAttrs, source: selector };
  }

  function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let cur = '';
    let quote = null;
    for (const c of s) {
      if (quote) { if (c === quote) quote = null; cur += c; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function scopedQueryAll(root, css) {
    const trimmed = css.trim();
    try {
      if (root.nodeType === 9) return Array.from(root.querySelectorAll(trimmed));
      if (/^[>+~]/.test(trimmed)) {
        if (/^[+~]/.test(trimmed)) {
          // Sibling combinators relative to the node itself.
          const parent = root.parentElement;
          if (!parent) return [];
          const k = Array.prototype.indexOf.call(parent.children, root) + 1;
          return Array.from(parent.querySelectorAll(`:scope > :nth-child(${k}) ${trimmed}`));
        }
        return Array.from(root.querySelectorAll(':scope ' + trimmed));
      }
      if (/^\s/.test(css) || trimmed === '*' || /^[a-z*#.[]/i.test(trimmed)) {
        return Array.from(root.querySelectorAll(':scope ' + trimmed));
      }
      return Array.from(root.querySelectorAll(trimmed));
    } catch {
      return [];
    }
  }

  function selfMatches(el, css) {
    try { return el.matches(css); } catch { return false; }
  }

  function run(compiled, roots) {
    let nodes = roots;
    for (let ti = 0; ti < compiled.tasks.length; ti++) {
      const task = compiled.tasks[ti];
      const next = [];
      switch (task.type) {
        case 'query':
          for (const r of nodes) next.push(...scopedQueryAll(r, task.css));
          break;
        case 'spath':
          // A compound selector right after an operator (".x:has-text(a).y")
          // filters the node itself; a combinator walks to related nodes.
          // At the start of a relative selector (inside :has()) it searches
          // below the node.
          for (const n of nodes) {
            if (ti === 0 || n.nodeType === 9 || /^[\s>+~]/.test(task.css)) {
              next.push(...scopedQueryAll(n, task.css));
            } else {
              const m = /^([^\s>+~]+)(.*)$/s.exec(task.css);
              if (m && selfMatches(n, m[1])) {
                if (m[2].trim()) next.push(...scopedQueryAll(n, m[2]));
                else next.push(n);
              }
            }
          }
          break;
        case 'text':
          for (const n of nodes) if (task.re.test(n.textContent || '')) next.push(n);
          break;
        case 'has':
          for (const n of nodes) {
            const found = task.self ? run(task.sub, [n]).includes(n) || run(task.sub, [n.parentNode || n]).includes(n) : run(task.sub, [n]).length > 0;
            if (found !== task.negate) next.push(n);
          }
          break;
        case 'is':
          for (const n of nodes) if (task.alternatives.some((a) => run(a, [n.parentNode || n]).includes(n))) next.push(n);
          break;
        case 'css':
          for (const n of nodes) {
            const v = getComputedStyle(n, task.pseudo)[task.prop.replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
            if (v !== undefined && task.re.test(v)) next.push(n);
          }
          break;
        case 'attr':
          for (const n of nodes) {
            for (const a of n.attributes || []) {
              if (task.nameRe.test(a.name) && (!task.valueRe || task.valueRe.test(a.value))) { next.push(n); break; }
            }
          }
          break;
        case 'prop':
          for (const n of nodes) {
            let v = n;
            for (const k of task.chain) { v = v == null ? undefined : v[k]; }
            if (v !== undefined && (!task.valueRe || task.valueRe.test(String(v)))) next.push(n);
          }
          break;
        case 'path':
          if (task.re.test(location.pathname + location.search)) next.push(...nodes);
          break;
        case 'media':
          if (window.matchMedia(task.query).matches) next.push(...nodes);
          break;
        case 'minlen':
          for (const n of nodes) if ((n.textContent || '').length >= task.n) next.push(n);
          break;
        case 'upward':
          for (const n of nodes) {
            let p = n;
            if (task.n !== null) {
              for (let i = 0; i < task.n && p; i++) p = p.parentElement;
            } else {
              p = n.parentElement;
              while (p && !selfMatches(p, task.sel)) p = p.parentElement;
            }
            if (p && p !== document.documentElement && p !== document.body) next.push(p);
          }
          break;
        case 'xpath':
          for (const r of nodes.length ? nodes : [document]) {
            try {
              const res = document.evaluate(task.expr, r, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              for (let i = 0; i < res.snapshotLength; i++) {
                const node = res.snapshotItem(i);
                if (node.nodeType === 1) next.push(node);
              }
            } catch {}
          }
          break;
        default:
          return [];
      }
      nodes = [...new Set(next)];
      if (nodes.length === 0) return nodes;
    }
    return nodes;
  }

  class Engine {
    constructor({ onHide } = {}) {
      this.rules = [];
      this.observer = null;
      this.scheduled = false;
      this.hidden = new WeakSet();
      this.hiddenCount = 0;
      this.onHide = onHide || (() => {});
      this.watchAttributes = false;
    }

    add(selectors, style) {
      for (const sel of selectors) {
        const c = compile(sel, false);
        if (!c) continue;
        if (style && !c.action) c.action = { type: 'style', arg: style };
        if (c.watchAttrs) this.watchAttributes = true;
        this.rules.push(c);
      }
      if (this.rules.length) this.start();
    }

    apply() {
      this.scheduled = false;
      if (!document.documentElement) return;
      for (const rule of this.rules) {
        const root = rule.tasks[0].type === 'xpath' ? [] : [document];
        let nodes;
        try { nodes = run(rule, root); } catch { continue; }
        for (const el of nodes) this.act(el, rule.action);
      }
    }

    act(el, action) {
      if (!action) {
        if (this.hidden.has(el)) return;
        el.style.setProperty('display', 'none', 'important');
        this.hidden.add(el);
        this.hiddenCount++;
        this.onHide(this.hiddenCount);
        return;
      }
      switch (action.type) {
        case 'remove':
          el.remove();
          this.hiddenCount++;
          this.onHide(this.hiddenCount);
          break;
        case 'style':
          for (const decl of action.arg.split(';')) {
            const m = /^\s*([-a-z]+)\s*:\s*(.+?)\s*(!important)?\s*$/i.exec(decl);
            if (!m || /url\(|expression\(/i.test(m[2])) continue;
            el.style.setProperty(m[1], m[2], 'important');
          }
          break;
        case 'remove-attr':
          for (const a of action.arg.split('|')) el.removeAttribute(unquote(a));
          break;
        case 'remove-class':
          for (const c of action.arg.split('|')) el.classList.remove(unquote(c));
          break;
      }
    }

    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      (window.requestIdleCallback || window.requestAnimationFrame)(() => this.apply(), { timeout: 100 });
    }

    start() {
      if (this.observer) return;
      const begin = () => {
        this.apply();
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: this.watchAttributes, characterData: false });
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
      else begin();
    }
  }

  globalThis.BastionProcedural = { compile, run, Engine };
})();
