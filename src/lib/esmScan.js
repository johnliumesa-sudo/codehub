// Tiny JavaScript lexer for the game bundler (src/lib/sandbox.js). It finds, without evaluating
// anything:
//   - module specifiers: import … from "x", import "x", export … from "x", import("x")
//   - string literals and the static head of template literals (`levels/${n}.json` -> "levels/"),
//     so the bundler can tell which workspace files the code refers to (fetch('levels.json')).
// Comments, strings, template literals (with nested ${…}) and regular expression literals are
// skipped, so `// import x from "y"` or "import x from 'y'" inside a string never match.
// It is a lexer, not a parser: a syntax error only makes it miss specifiers, never throw.

const ID_START = /[A-Za-z_$\u0080-\uffff]/;
const ID_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
// After these keywords a "/" starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const STATEMENT_START = new Set(['import', 'export', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'return']);

/**
 * Scan `src`. Returns { specifiers: [{ spec, start, end, dynamic }], strings: [{ value, start, end, template }] }.
 * start/end of a specifier cover the whole literal including its quotes, so a caller can replace it
 * with JSON.stringify(newSpec).
 */
export function scanModule(src) {
  const s = String(src ?? '');
  const n = s.length;
  const specifiers = [];
  const strings = [];
  const stack = []; // '{' for a normal brace, '`' for a ${ inside a template literal
  let i = 0;
  // Last significant token: { t: 'word'|'num'|'punct'|'str'|'regex'|'tpl', v }
  let last = { t: 'punct', v: ';' };

  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029';

  // Skip whitespace and comments from `j`; returns the next significant index.
  const skipTrivia = (j) => {
    while (j < n) {
      const c = s[j];
      if (isWs(c)) j++;
      else if (c === '/' && s[j + 1] === '/') {
        const e = s.indexOf('\n', j + 2);
        j = e < 0 ? n : e + 1;
      } else if (c === '/' && s[j + 1] === '*') {
        const e = s.indexOf('*/', j + 2);
        j = e < 0 ? n : e + 2;
      } else break;
    }
    return j;
  };

  // A quoted string starting at j (s[j] is the quote). Returns { value, end } (end = index after the closing quote).
  const readString = (j) => {
    const q = s[j];
    let k = j + 1;
    let value = '';
    while (k < n) {
      const c = s[k];
      if (c === '\\') {
        const nx = s[k + 1];
        const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (nx === 'u' || nx === 'x') {
          const m = nx === 'x' ? /^x([0-9a-fA-F]{2})/.exec(s.slice(k + 1, k + 4)) : /^u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(s.slice(k + 1, k + 10));
          if (m) {
            const cp = parseInt(m[1] || m[2], 16);
            value += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
            k += 1 + m[0].length;
            continue;
          }
        }
        if (nx === '\r' && s[k + 2] === '\n') k += 3;
        else {
          if (nx !== '\n' && nx !== '\r' && nx !== '\u2028' && nx !== '\u2029') value += simple[nx] ?? nx ?? '';
          k += 2;
        }
        continue;
      }
      if (c === q) return { value, end: k + 1 };
      if (c === '\n') return { value, end: k }; // unterminated: stop at the line end
      value += c;
      k++;
    }
    return { value, end: n };
  };

  // Template literal text from j (just after ` or }) up to the closing ` or ${.
  // Returns { text, end, open } where open=true means it stopped at ${ (end is after the brace).
  const readTemplateChunk = (j) => {
    let k = j;
    let text = '';
    while (k < n) {
      const c = s[k];
      if (c === '\\') {
        text += s[k + 1] ?? '';
        k += 2;
        continue;
      }
      if (c === '`') return { text, end: k + 1, open: false };
      if (c === '$' && s[k + 1] === '{') return { text, end: k + 2, open: true };
      text += c;
      k++;
    }
    return { text, end: n, open: false };
  };

  const skipRegex = (j) => {
    let k = j + 1;
    let inClass = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '\n') return k; // not a regex after all; bail out at the line end
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') inClass = true;
      else if (c === '/') {
        k++;
        while (k < n && ID_PART.test(s[k])) k++;
        return k;
      }
      k++;
    }
    return n;
  };

  const regexAllowed = () => {
    if (last.t === 'word') return REGEX_AFTER_WORD.has(last.v);
    if (last.t === 'num' || last.t === 'str' || last.t === 'regex' || last.t === 'tpl') return false;
    return !(last.v === ')' || last.v === ']');
  };

  const pushString = (start, end, value, template = false) => strings.push({ value, start, end, template });

  // At index j (after `import` / `export … from`), expect a string literal; record it as a specifier.
  const takeSpecifier = (j, dynamic) => {
    const k = skipTrivia(j);
    if (s[k] !== '"' && s[k] !== "'") return false;
    const r = readString(k);
    if (!specifiers.some((x) => x.start === k)) specifiers.push({ spec: r.value, start: k, end: r.end, dynamic });
    return true;
  };

  // From j, look for `from "x"` before the statement obviously ends. Handles import clauses
  // ({ a as b }, * as ns, default, mixed) and export clauses (export * [as ns] / export { … }).
  const findFrom = (j) => {
    let k = j;
    let depth = 0;
    const limit = Math.min(n, j + 4000);
    while (k < limit) {
      k = skipTrivia(k);
      const c = s[k];
      if (c === undefined) return;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ';' || c === '(' || c === '=' || c === ')' ) return;
      else if (c === '"' || c === "'") {
        if (depth > 0) {
          k = readString(k).end; // `import { "a-b" as ab }` string export names
          continue;
        }
        return;
      } else if (ID_START.test(c)) {
        let e = k + 1;
        while (e < n && ID_PART.test(s[e])) e++;
        const w = s.slice(k, e);
        if (depth === 0 && w === 'from') {
          takeSpecifier(e, false);
          return;
        }
        if (depth === 0 && STATEMENT_START.has(w)) return; // the next statement began: no `from` here
        k = e;
        continue;
      }
      k++;
    }
  };

  while (i < n) {
    const c = s[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      i = skipTrivia(i);
      continue;
    }
    if (c === '"' || c === "'") {
      const r = readString(i);
      pushString(i, r.end, r.value);
      i = r.end;
      last = { t: 'str' };
      continue;
    }
    if (c === '`') {
      const r = readTemplateChunk(i + 1);
      pushString(i, r.end, r.text, true);
      i = r.end;
      if (r.open) {
        stack.push('`');
        last = { t: 'punct', v: '{' };
      } else last = { t: 'tpl' };
      continue;
    }
    if (c === '{') {
      stack.push('{');
      last = { t: 'punct', v: '{' };
      i++;
      continue;
    }
    if (c === '}') {
      const top = stack.pop();
      if (top === '`') {
        const r = readTemplateChunk(i + 1);
        i = r.end;
        if (r.open) {
          stack.push('`');
          last = { t: 'punct', v: '{' };
        } else last = { t: 'tpl' };
        continue;
      }
      last = { t: 'punct', v: '}' };
      i++;
      continue;
    }
    if (c === '/') {
      if (regexAllowed()) {
        i = skipRegex(i);
        last = { t: 'regex' };
      } else {
        i++;
        last = { t: 'punct', v: '/' };
      }
      continue;
    }
    if (c >= '0' && c <= '9') {
      let e = i + 1;
      while (e < n && /[0-9A-Za-z_.]/.test(s[e])) e++;
      i = e;
      last = { t: 'num' };
      continue;
    }
    if (ID_START.test(c) || (c === '#' && ID_START.test(s[i + 1] || ''))) {
      let e = i + 1;
      while (e < n && ID_PART.test(s[e])) e++;
      const w = s.slice(i, e);
      const member = last.t === 'punct' && (last.v === '.' || last.v === '?.');
      if (!member && w === 'import') {
        const k = skipTrivia(e);
        if (s[k] === '(') takeSpecifier(k + 1, true);
        else if (s[k] === '"' || s[k] === "'") takeSpecifier(k, false);
        else if (s[k] !== '.') findFrom(k);
      } else if (!member && w === 'export') {
        const k = skipTrivia(e);
        if (s[k] === '*' || s[k] === '{') findFrom(k);
      }
      i = e;
      last = { t: 'word', v: w };
      continue;
    }
    // Punctuators: keep `.` and `?.` distinct for member-access detection.
    if (c === '?' && s[i + 1] === '.' && !/[0-9]/.test(s[i + 2] || '')) {
      last = { t: 'punct', v: '?.' };
      i += 2;
      continue;
    }
    if (c === '.' && s[i + 1] === '.' && s[i + 2] === '.') {
      last = { t: 'punct', v: '...' };
      i += 3;
      continue;
    }
    last = { t: 'punct', v: c };
    i++;
  }
  return { specifiers, strings };
}

/** True when the code uses ES module syntax (a static import/export), so it must run as a module. */
export function looksLikeModule(src) {
  const text = String(src ?? '');
  if (!/\b(?:import|export)\b/.test(text)) return false;
  const { specifiers } = scanModule(text);
  if (specifiers.some((x) => !x.dynamic)) return true;
  // `export const x = 1` / `export default …` without any import.
  return /(^|[\n;{}])\s*export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\s+function\b|\{|\*)/.test(stripComments(text));
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** Replace ranges [{start, end, text}] in `src` (non-overlapping), right to left. */
export function applyEdits(src, edits) {
  let out = String(src);
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
