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

export const AUTOMOD_LIMITS = Object.freeze({ words: 200, wordLen: 60, maxMentions: 50, capsMinLetters: 12 });
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDCH = '[\\p{L}\\p{N}_]';
const compiled = new Map();

/** Pattern -> RegExp over normalized text (whole words; `*` = any word characters). */
export function patternRegExp(p) {
  let re = compiled.get(p);
  if (re) return re;
  const body = p.split(' ').map((w) => w.split('*').map(escapeRe).join(`${WORDCH}*`)).join('\\s+');
  re = new RegExp(`(?<!${WORDCH})${body}(?!${WORDCH})`, 'u');
  if (compiled.size > 2000) compiled.clear();
  compiled.set(p, re);
  return re;
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
    const norm = normalizeText(text).replace(/\s+/g, ' ');
    if (cfg.words.some((p) => patternRegExp(p).test(norm))) return { rule: 'words', reason: 'it contains a word or phrase this server blocks' };
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
