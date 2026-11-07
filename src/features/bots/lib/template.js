// The bot response template language. Pure text substitution, never code:
//   {user} {mention} {channel} {server} {args} {arg1}..{arg9} {random:a|b|c} {dice:NdM}
//   {date} {time} {count}
// Single pass: substituted values are never scanned again, so input such as "{random:…}" typed by a
// member stays literal. Everything a member typed (names, channel/server names, arguments) is
// markdown-escaped; the bot author's own text ({random:…} choices and the template) is not.
// Unknown placeholders are kept as written.
import { cryptoUint32, pick, rollDice } from './dice.js';

export const MAX_OUTPUT = 4000; // = messages.MAX_TEXT

/** Placeholders shown in the builder's help, in order. */
export const PLACEHOLDERS = Object.freeze([
  ['{user}', 'Display name of the member who used the bot'],
  ['{mention}', '@mention of that member'],
  ['{channel}', 'Channel name'],
  ['{server}', 'Server name'],
  ['{args}', 'Everything typed after the command'],
  ['{arg1} … {arg9}', 'One word typed after the command ("quotes" group words)'],
  ['{random:a|b|c}', 'One of the choices, picked at random'],
  ['{dice:NdM}', 'Total of N dice with M sides, e.g. {dice:2d6}'],
  ['{date}', 'Today\'s date (the sender\'s clock)'],
  ['{time}', 'The current time (the sender\'s clock)'],
  ['{count}', 'How many times this command or trigger ran (counted in the sender\'s browser)'],
]);

const MENTION_TOKEN = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;

/**
 * Escape member-typed text so it renders literally inside a bot reply: whitespace collapses to one
 * line, and markdown, spoilers, :shortcodes:, @mentions, raw HTML/autolinks and line-start block
 * markers (#, >, -, +, =, "1.") are backslash-escaped (CommonMark escapes, shown as the plain char).
 */
export function escapeMarkdown(input) {
  let s = String(input ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') // eslint-disable-line no-control-regex
    .replace(/\s+/g, ' ')
    .trim();
  s = s
    .replace(/[\\`*_~[\]|<>]/g, '\\$&')
    .replace(/:(?=[a-z0-9_+-])/gi, '\\:')
    .replace(/@(?=[\p{L}\p{N}_-])/gu, '\\@')
    .replace(/^([#+=-])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');
  return s;
}

/** "@Token" for a display name (the composer's mention token), or the escaped name if it can't be one. */
export function mentionFor(name) {
  const tok = String(name ?? '').replace(/\s+/g, '');
  return tok && MENTION_TOKEN.test(tok) ? `@${tok}` : escapeMarkdown(name);
}

/** Split command arguments on whitespace; "double quotes" group words. */
export function splitArgs(args) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  const s = String(args ?? '');
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** Bot output must not be read as a slash command when it is sent through the pipeline. */
export function guardLeadingSlash(text) {
  return /^\s*\//.test(text) ? `\\${text.trimStart()}` : text;
}

const PH = /\{(user|mention|channel|server|args|arg[1-9]|date|time|count|random:([^{}]*)|dice:([^{}]*))\}/g;

/**
 * Render a template.
 * vars: { user, channel, server, args, count, now?: Date, locale?: string }
 * opts.u32: random source (tests). Output is trimmed, capped at MAX_OUTPUT and never starts with "/".
 */
export function renderTemplate(template, vars = {}, opts = {}) {
  const u32 = opts.u32 || cryptoUint32;
  const now = vars.now instanceof Date ? vars.now : new Date();
  const locale = typeof vars.locale === 'string' ? vars.locale : undefined;
  const argList = splitArgs(vars.args);
  const out = String(template ?? '').replace(PH, (whole, name, randomArg, diceArg) => {
    if (randomArg !== undefined) return pick(randomArg.split('|'), u32) ?? '';
    if (diceArg !== undefined) {
      const r = rollDice(diceArg, u32);
      return r ? String(r.total) : whole;
    }
    switch (name) {
      case 'user': return escapeMarkdown(vars.user);
      case 'mention': return mentionFor(vars.user);
      case 'channel': return escapeMarkdown(vars.channel);
      case 'server': return escapeMarkdown(vars.server);
      case 'args': return escapeMarkdown(vars.args);
      case 'date': return escapeMarkdown(now.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }));
      case 'time': return escapeMarkdown(now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }));
      case 'count': return String(Number.isFinite(vars.count) ? Math.max(0, Math.floor(vars.count)) : 0);
      default: // arg1..arg9
        return escapeMarkdown(argList[Number(name.slice(3)) - 1] ?? '');
    }
  });
  let text = guardLeadingSlash(out.trim());
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT - 1)}…`;
  return text;
}

/** True if a template uses {count} (only then is the local counter touched). */
export const usesCount = (template) => /\{count\}/.test(String(template ?? ''));
