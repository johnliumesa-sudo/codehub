// Markdown rendering for chat messages: marked (GFM) -> DOMPurify, highlight.js (core +
// a curated language set) for fenced code, `:shortcode:` emoji, and `@mention` chips.
//
// Everything that reaches the DOM goes through DOMPurify. Raw HTML in messages is shown
// as text, and remote images are rendered as links (loading them would leak IPs).
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import emojiData from '@emoji-mart/data';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, ini, java, javascript, json, kotlin, lua,
  makefile, markdown, php, plaintext, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

// Languages offered in the "share code snippet" picker (value -> label).
export const SNIPPET_LANGUAGES = [
  ['plaintext', 'Plain text'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'],
  ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['go', 'Go'], ['rust', 'Rust'], ['ruby', 'Ruby'],
  ['php', 'PHP'], ['swift', 'Swift'], ['kotlin', 'Kotlin'], ['lua', 'Lua'], ['bash', 'Bash'], ['shell', 'Shell session'],
  ['sql', 'SQL'], ['json', 'JSON'], ['yaml', 'YAML'], ['xml', 'HTML / XML'], ['css', 'CSS'], ['scss', 'SCSS'],
  ['markdown', 'Markdown'], ['graphql', 'GraphQL'], ['dockerfile', 'Dockerfile'], ['makefile', 'Makefile'],
  ['ini', 'INI / TOML'], ['diff', 'Diff'],
];

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin', lua: 'lua', sh: 'bash', bash: 'bash',
  zsh: 'bash', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', md: 'markdown', graphql: 'graphql', gql: 'graphql', toml: 'ini', ini: 'ini',
  diff: 'diff', patch: 'diff',
};

export function langFromFilename(filename = '') {
  const base = filename.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return EXT_LANG[base.split('.').pop()] || null;
}

export function languageLabel(lang) {
  const found = SNIPPET_LANGUAGES.find(([v]) => v === lang);
  if (found) return found[1];
  return (lang && hljs.getLanguage(lang)?.name) || lang || 'text';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Returns highlighted HTML (already escaped by highlight.js). Unknown languages are auto-detected
// for short snippets, otherwise escaped as plain text.
export function highlightCode(code, lang) {
  const l = (lang || '').toLowerCase().trim();
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    if (!l && code.length < 20000) return hljs.highlightAuto(code).value;
  } catch {
    /* fall through */
  }
  return escapeHtml(code);
}

// ---------- Emoji ----------

const shortcodes = new Map(); // id/alias -> native
const emojiIndex = []; // { id, native, keywords }
for (const e of Object.values(emojiData.emojis)) {
  const native = e.skins?.[0]?.native;
  if (!native) continue;
  shortcodes.set(e.id, native);
  emojiIndex.push({ id: e.id, native, name: e.name.toLowerCase(), keywords: e.keywords || [] });
}
for (const [alias, id] of Object.entries(emojiData.aliases || {})) {
  if (!shortcodes.has(alias) && shortcodes.has(id)) {
    shortcodes.set(alias, shortcodes.get(id));
    emojiIndex.push({ id: alias, native: shortcodes.get(id), name: alias, keywords: [] });
  }
}
// A few Slack/Discord-isms people type out of habit.
for (const [alias, id] of Object.entries({ thumbsup: '+1', thumbsdown: '-1', smile: 'smile', heart: 'heart', tada: 'tada' })) {
  if (!shortcodes.has(alias) && shortcodes.has(id)) shortcodes.set(alias, shortcodes.get(id));
}

export function shortcodeToNative(code) {
  return shortcodes.get(String(code).toLowerCase()) || null;
}

// Prefix matches on the id first, then substring/keyword matches.
export function searchEmoji(query, limit = 8) {
  const q = String(query).toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const e of emojiIndex) {
    if (e.id.startsWith(q)) starts.push(e);
    else if (e.id.includes(q) || e.name.includes(q) || e.keywords.some((k) => k.startsWith(q))) contains.push(e);
    if (starts.length >= limit) break;
  }
  starts.sort((a, b) => a.id.length - b.id.length);
  return [...starts, ...contains].slice(0, limit).map(({ id, native }) => ({ id, native }));
}

// Replace :shortcodes: in plain text (used for composer previews / edits, not rendering).
export function replaceShortcodes(text) {
  return text.replace(/:([a-z0-9_+-]{1,40}):/gi, (m, code) => shortcodeToNative(code) || m);
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9](?=️?⃣)|:[a-z0-9_+-]{1,40}:|\s)+$/u;

// "Jumbo" emoji rendering for short emoji-only messages.
export function isEmojiOnly(text) {
  const t = (text || '').trim();
  if (!t || t.length > 80 || !EMOJI_ONLY.test(t)) return false;
  const codes = t.match(/:([a-z0-9_+-]{1,40}):/gi) || [];
  if (codes.some((c2) => !shortcodeToNative(c2.slice(1, -1)))) return false;
  const stripped = t.replace(/:([a-z0-9_+-]{1,40}):/gi, 'x').replace(/\s/g, '');
  const graphemes = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter().segment(stripped)].length
    : stripped.length;
  return graphemes <= 10;
}

// ---------- Mentions ----------

const MENTION_RE = /^@([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/u;

// The token a user is mentioned by: their display name without whitespace.
export function mentionToken(name = '') {
  return String(name).replace(/\s+/g, '');
}

// True when `text` mentions @everyone/@here or any of the given names.
export function mentionsName(text, name) {
  if (!text) return false;
  const tokens = new Set(['everyone', 'here']);
  if (name) {
    tokens.add(mentionToken(name).toLowerCase());
    const first = String(name).trim().split(/\s+/)[0];
    if (first) tokens.add(first.toLowerCase());
  }
  const re = /(^|[\s(])@([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/gu;
  let m;
  while ((m = re.exec(stripCode(text)))) if (tokens.has(m[2].toLowerCase())) return true;
  return false;
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// ---------- Marked setup ----------

let ctx = { selfTokens: new Set(), knownTokens: null };

const marked = new Marked({ gfm: true, breaks: true, async: false });

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      const html = highlightCode(text, language);
      const label = language ? escapeHtml(languageLabel(language)) : 'code';
      return (
        `<div class="md-code"><div class="md-code-head"><span class="md-code-lang">${label}</span>` +
        `<button type="button" class="md-copy" data-copy="1">Copy</button></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>`
      );
    },
    // Never render raw HTML from a message; show it as text.
    html({ text }) {
      return escapeHtml(text);
    },
    image({ href, text }) {
      const safe = escapeHtml(href || '');
      return `<a href="${safe}" class="md-img-link">🖼 ${escapeHtml(text || href || 'image')}</a>`;
    },
  },
  extensions: [
    {
      name: 'shortcode',
      level: 'inline',
      start(src) {
        const i = src.search(/:[a-z0-9_+-]{1,40}:/i);
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^:([a-z0-9_+-]{1,40}):/i.exec(src);
        if (!m) return undefined;
        const native = shortcodeToNative(m[1]);
        if (!native) return undefined;
        return { type: 'shortcode', raw: m[0], native, code: m[1] };
      },
      renderer(token) {
        return `<span class="emoji" title=":${escapeHtml(token.code)}:">${token.native}</span>`;
      },
    },
    {
      name: 'mention',
      level: 'inline',
      start(src) {
        const m = /(^|[\s(])@[\p{L}\p{N}_-]/u.exec(src);
        return m ? m.index + m[1].length : undefined;
      },
      tokenizer(src) {
        const m = MENTION_RE.exec(src);
        if (!m) return undefined;
        return { type: 'mention', raw: m[0], name: m[1] };
      },
      renderer(token) {
        const lower = token.name.toLowerCase();
        const special = lower === 'everyone' || lower === 'here';
        const known = special || !ctx.knownTokens || ctx.knownTokens.has(lower);
        if (!known) return escapeHtml(token.raw);
        const cls = ['mention'];
        if (special || ctx.selfTokens.has(lower)) cls.push('me');
        return `<span class="${cls.join(' ')}" data-mention="${escapeHtml(token.name)}">@${escapeHtml(token.name)}</span>`;
      },
    },
  ],
});

// ---------- Sanitizer ----------

const purifier = DOMPurify(typeof window !== 'undefined' ? window : undefined);
purifier.addHook?.('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) {
      node.removeAttribute('href');
    } else {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  }
});

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'strong', 'i', 'em', 'del', 's', 'code', 'pre', 'p', 'br', 'hr', 'blockquote', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'button', 'input',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled', 'start', 'align', 'data-copy', 'data-mention', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ['style', 'id', 'name'],
};

export function sanitize(html) {
  // DOMPurify needs a DOM; without one (never the case in the app) fail closed.
  if (!purifier.isSupported) return escapeHtml(html);
  return purifier.sanitize(html, PURIFY_CONFIG);
}

/**
 * Render message Markdown to sanitized HTML.
 * @param {string} text
 * @param {{ selfName?: string, knownNames?: string[] }} [opts]
 *   selfName: highlights mentions of the current user. knownNames: if given, only these
 *   (plus @everyone/@here) render as mention chips.
 */
export function renderMarkdown(text, opts = {}) {
  const selfTokens = new Set();
  if (opts.selfName) {
    selfTokens.add(mentionToken(opts.selfName).toLowerCase());
    const first = opts.selfName.trim().split(/\s+/)[0];
    if (first) selfTokens.add(first.toLowerCase());
  }
  let knownTokens = null;
  if (opts.knownNames) {
    knownTokens = new Set();
    for (const n of opts.knownNames) {
      if (!n) continue;
      knownTokens.add(mentionToken(n).toLowerCase());
      knownTokens.add(n.trim().split(/\s+/)[0].toLowerCase());
    }
  }
  const prev = ctx;
  ctx = { selfTokens, knownTokens };
  try {
    return sanitize(marked.parse(String(text || '')));
  } catch {
    return sanitize(`<p>${escapeHtml(text)}</p>`);
  } finally {
    ctx = prev;
  }
}
