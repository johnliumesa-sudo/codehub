// AutoMod (client-enforced): pure config cleaning and message checks, shared by the sender's send
// hook, the readers' render check and the unit tests.
//
// Config (sealed with the server key, AAD `automod:{sid}/cfg`, stored at sconf/{sid}/automod/cfg):
//   { words: [pattern], invites: bool, links: bool, maxMentions: 0..50 (0 = off),
//     caps: 0 | 50..100 (percent of capital letters, 0 = off), action: 'block' | 'hide', exemptMods: bool }
// Patterns are case-insensitive and match whole words; `*` stands for any run of letters/digits
// (`spam*` matches "spammer", `*coin` matches "bitcoin", `*bad*` matches inside words); a pattern with
// spaces is a phrase. Messages are end-to-end encrypted, so only members' browsers can check them: a
// modified client can bypass AutoMod. The UI and docs say so.
//
// Matching never uses regular expressions built from patterns (a pattern like `a*a*a*…b` made a
// backtracking regex take seconds per message). Text and pattern are split into tokens (maximal runs
// of letters/digits/_, and single other characters); a pattern matches when its tokens match a run
// of consecutive text tokens, a word token being a glob matched with ordered indexOf (linear). Words
// longer than `testWord` characters are checked on their first `testWord` characters.

export const AUTOMOD_LIMITS = Object.freeze({ words: 200, wordLen: 60, maxMentions: 50, capsMinLetters: 12, testWord: 256 });
export const AUTOMOD_ACTIONS = Object.freeze(['block', 'hide']);
export const DEFAULT_AUTOMOD = Object.freeze({ words: [], invites: false, links: false, maxMentions: 0, caps: 0, action: 'block', exemptMods: true });
export const automodAad = (sid) => `automod:${sid}/cfg`;

const ZW = /[­​-‏⁠-⁤﻿]/g;

/** Lower-case, NFKC-folded, accent- and zero-width-free text, so "Ｓpäm" matches "spam". */
export function normalizeText(s) {
  return String(s ?? '').normalize('NFKC').normalize('NFD').replace(/\p{M}+/gu, '').replace(ZW, '').toLowerCase();
}

/** One pattern as typed -> normalized pattern ('' if unusable). */
export function cleanPattern(p) {
  const s = normalizeText(p).replace(/\s+/g, ' ').trim().replace(/\*{2,}/g, '*').slice(0, AUTOMOD_LIMITS.wordLen);
  return s.replace(/\*/g, '') ? s : '';
}

/** Words from a textarea (one per line or comma separated) -> unique clean patterns. */
export function parseWordList(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\n,]/)) {
    const p = cleanPattern(raw);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= AUTOMOD_LIMITS.words) break;
  }
  return out;
}

/** Any stored/decrypted config (untrusted) -> a complete, valid config. */
export function cleanAutomod(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const words = Array.isArray(c.words) ? parseWordList(c.words.filter((w) => typeof w === 'string').join('\n')) : [];
  const mm = Number.isInteger(c.maxMentions) ? Math.min(Math.max(c.maxMentions, 0), AUTOMOD_LIMITS.maxMentions) : 0;
  const caps = Number.isInteger(c.caps) && c.caps >= 50 && c.caps <= 100 ? c.caps : 0;
  return {
    words,
    invites: c.invites === true,
    links: c.links === true,
    maxMentions: mm,
    caps,
    action: AUTOMOD_ACTIONS.includes(c.action) ? c.action : 'block',
    exemptMods: c.exemptMods !== false,
  };
}

/** True if the config checks anything at all. */
export const automodActive = (cfg) => !!cfg && (cfg.words.length > 0 || cfg.invites || cfg.links || cfg.maxMentions > 0 || cfg.caps > 0);

// Tokens: a maximal run of word characters, or one other character (a code point).
const TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]/gu;
const WORD_RE = /^[\p{L}\p{N}_]/u;

/** Normalized text -> tokens [{ w: isWord, s }] (word tokens cut to AUTOMOD_LIMITS.testWord). */
export function tokenize(text) {
  const out = [];
  for (const [s] of String(text ?? '').matchAll(TOKEN_RE)) {
    const w = WORD_RE.test(s);
    out.push({ w, s: w && s.length > AUTOMOD_LIMITS.testWord ? s.slice(0, AUTOMOD_LIMITS.testWord) : s });
  }
  return out;
}

/**
 * Glob match of one whole word against pieces split on `*` (pieces.length >= 2 when it has a star):
 * the first piece anchors at the start, the last at the end, the middle ones are found in order with
 * indexOf (the earliest occurrence is always the right choice, so this is linear in the word).
 */
function globWord(pieces, word) {
  if (pieces.length === 1) return word === pieces[0];
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (word.length < first.length + last.length || !word.startsWith(first) || !word.endsWith(last)) return false;
  let pos = first.length;
  const end = word.length - last.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const p = pieces[i];
    if (!p) continue;
    const at = word.indexOf(p, pos);
    if (at < 0 || at + p.length > end) return false;
    pos = at + p.length;
  }
  return true;
}

const compiled = new Map();

/**
 * A clean pattern -> { toks, exact }: toks are { w: true, pieces, any } for word globs (`any`: only
 * stars) and { w: false, s } for other characters; `exact` lists the token strings the text must
 * contain (non-word characters and words without `*`).
 */
export function compilePattern(p) {
  let c = compiled.get(p);
  if (c) return c;
  // `*` joins word characters into one glob token: "spam*" and "*bad*" are one word each.
  const toks = [];
  for (const [s] of String(p).matchAll(/[\p{L}\p{N}_*]+|[^\p{L}\p{N}_*]/gu)) {
    if (/^[^\p{L}\p{N}_*]$/u.test(s)) toks.push({ w: false, s });
    else toks.push({ w: true, pieces: s.split('*'), any: !s.replace(/\*/g, '') });
  }
  const exact = toks.filter((t) => !t.w || t.pieces.length === 1).map((t) => (t.w ? t.pieces[0] : t.s));
  c = { toks, exact };
  if (compiled.size > 2000) compiled.clear();
  compiled.set(p, c);
  return c;
}

/** Tokens -> { toks, at: Map token -> [positions], words: [word positions] } (built once per message). */
export function indexTokens(toks) {
  const at = new Map();
  const words = [];
  toks.forEach((t, i) => {
    if (t.w) words.push(i);
    const list = at.get(t.s);
    if (list) list.push(i);
    else at.set(t.s, [i]);
  });
  return { toks, at, words };
}

/** Upper bound on token comparisons per message; past it the message counts as unchecked (see below). */
export const MATCH_BUDGET = 2_000_000;

/**
 * Does a compiled pattern occur in indexed text as a whole-word match (no word character right before
 * or after it)? Word globs match one whole text word; a glob of only `*` may also match nothing (e.g.
 * between two punctuation marks). Only positions holding the pattern's first token are tried, and a
 * pattern whose exact tokens don't all occur is skipped. `budget.left` counts comparisons down:
 * returns true, false, or null when the budget ran out.
 */
export function matchIndexed(pat, ix, budget = { left: MATCH_BUDGET }) {
  const { toks: ptoks, exact } = pat;
  if (!ptoks.length || exact.some((s) => !ix.at.has(s))) return false;
  const { toks } = ix;
  const n = toks.length;
  const first = ptoks[0];
  let starts;
  if (!first.w || first.pieces.length === 1) starts = ix.at.get(first.w ? first.pieces[0] : first.s);
  else if (!first.any) starts = ix.words;
  else starts = toks.map((_, i) => i);
  for (const i of starts) {
    if (i > 0 && toks[i - 1].w) continue; // would start right after a word character
    let j = i;
    let ok = true;
    for (const pt of ptoks) {
      if (--budget.left < 0) return null;
      const t = toks[j];
      if (pt.w) {
        if (t && t.w && globWord(pt.pieces, t.s)) j++;
        else if (!pt.any || (t && t.w)) {
          ok = false;
          break;
        }
      } else if (t && !t.w && t.s === pt.s) j++;
      else {
        ok = false;
        break;
      }
    }
    if (ok && j > i && !(j < n && toks[j].w)) return true;
  }
  return false;
}

/** True if a clean pattern matches normalized text (whole words; `*` = any word characters). */
export function patternMatches(p, text) {
  return matchIndexed(compilePattern(p), indexTokens(tokenize(text))) === true;
}

// Codehub invites (#/join/...) plus the common chat-app invite hosts.
const INVITE_RE = /#\/join\/[^/\s]+\/[^/\s]+\/|\b(?:discord(?:app)?\.(?:gg|com\/invite)|t\.me\/(?:joinchat|\+)|chat\.whatsapp\.com|join\.slack\.com|matrix\.to\/#\/[#!])/i;
// Anything the markdown renderer turns into a link: scheme URLs, www. hosts, <autolinks>, and markdown links.
const LINK_RE = /\b(?:https?|ftp):\/\/\S|\bwww\.[a-z0-9-]+\.[a-z]|<[a-z][a-z0-9+.-]*:[^>\s]+>|\]\([^)\s]+\)|\bmailto:/i;
const MENTION_RE = /(^|[\s(])@[\p{L}\p{N}_-]/gu;
const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

const plainOf = (text) => String(text ?? '').replace(CODE_RE, ' ');

/** The text AutoMod looks at in a message body: text, poll question/options, code file name. */
export function bodyText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [typeof body.text === 'string' ? body.text : ''];
  if (body.poll && typeof body.poll === 'object') {
    if (typeof body.poll.q === 'string') parts.push(body.poll.q);
    if (Array.isArray(body.poll.options)) body.poll.options.forEach((o) => typeof o === 'string' && parts.push(o));
  }
  if (body.code && typeof body.code.filename === 'string') parts.push(body.code.filename);
  return parts.join('\n');
}

/**
 * Check a message body (or draft) against a config. Returns null when it passes, otherwise
 * { rule: 'words'|'invites'|'links'|'mentions'|'caps', reason } with a short explanation that never
 * repeats the blocked word (so the notice itself doesn't show it).
 */
export function checkMessage(body, cfg) {
  if (!automodActive(cfg)) return null;
  const text = bodyText(body);
  if (cfg.words.length) {
    const ix = indexTokens(tokenize(normalizeText(text).replace(/\s+/g, ' ')));
    const budget = { left: MATCH_BUDGET };
    for (const p of cfg.words) {
      const hit = matchIndexed(compilePattern(p), ix, budget);
      if (hit) return { rule: 'words', reason: 'it contains a word or phrase this server blocks' };
      // Only a very long, repetitive message against long repetitive patterns gets here: fail closed.
      if (hit === null) return { rule: 'words', reason: 'it is too long and repetitive for AutoMod to check' };
    }
  }
  if (cfg.invites && (INVITE_RE.test(text) || (body && body.invite))) return { rule: 'invites', reason: 'invite links are not allowed here' };
  if (cfg.links && (LINK_RE.test(text) || (body && (body.invite || body.gif)))) return { rule: 'links', reason: 'links are not allowed here' };
  const plain = plainOf(text);
  if (cfg.maxMentions > 0) {
    const n = (plain.match(MENTION_RE) || []).length;
    if (n > cfg.maxMentions) return { rule: 'mentions', reason: `it mentions ${n} people (the limit is ${cfg.maxMentions})` };
  }
  if (cfg.caps > 0) {
    const letters = plain.replace(/(?:https?:\/\/|www\.)\S+/gi, '').match(/\p{L}/gu) || [];
    const cased = letters.filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
    if (cased.length >= AUTOMOD_LIMITS.capsMinLetters) {
      const upper = cased.filter((ch) => ch === ch.toUpperCase()).length;
      if ((upper * 100) / cased.length >= cfg.caps) return { rule: 'caps', reason: `${Math.round((upper * 100) / cased.length)}% of it is in capital letters (the limit is ${cfg.caps}%)` };
    }
  }
  return null;
}

/** Whether AutoMod skips this author: owner and admins always; moderators (manageMessages or manageApps) if exemptMods. */
export function isExempt(perms, cfg) {
  if (!perms) return false;
  if (perms.staff) return true;
  return !!cfg?.exemptMods && !!(perms.manageMessages || perms.manageApps);
}
