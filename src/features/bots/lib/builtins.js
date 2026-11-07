// Built-in slash commands (feature 1). Each result is an ordinary message sent by the member, with
// `extra.cmd` = the command name so readers see a small "used /roll" note. /poll and /gif open the
// existing poll creator and GIF picker (through the composer host) instead of sending.
// Pure apart from the tool bus, unit-tested in tests/unit/bots.test.mjs.
import { cryptoUint32, flipCoin, formatRoll, rollDice, DICE_LIMITS } from './dice.js';
import { openTool } from './toolbus.js';

export const SHRUG = '¯\\\\\\_(ツ)\\_/¯'; // markdown source for ¯\_(ツ)_/¯
export const TABLEFLIP = '(╯°□°)╯︵ ┻━┻';
export const UNFLIP = '┬─┬ノ( º _ ºノ)';

const MAX = 4000;
const tag = (name, text) => ({ text, extra: { cmd: name } });
const withText = (args, face) => (args ? `${args} ${face}` : face);
const usage = (u) => ({ cancel: true, reason: `Usage: ${u}` });

/** /me text: the action in italics on one line (backslashes and underscores escaped so it stays one emphasis). */
export function meText(action) {
  const a = String(action ?? '').replace(/\s+/g, ' ').trim();
  if (!a) return '';
  return `_${a.replace(/[\\_]/g, '\\$&')}_`;
}

/** /spoiler text: one line, no "|" (a spoiler ends at the first "|"), never starting with a space. */
export function spoilerText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '¦');
  return t ? `||${t}||` : '';
}

/** /roll text, or null for an invalid spec. */
export function rollText(spec, u32 = cryptoUint32) {
  const r = rollDice(spec, u32);
  if (!r) return null;
  return `🎲 ${formatRoll(r).replace(/= (-?\d+)$/, '= **$1**').replace(/^(rolled \S+: )(-?\d+)$/, '$1**$2**')}`;
}

export const BUILTIN_COMMANDS = Object.freeze([
  {
    name: 'shrug',
    args: '[text]',
    description: 'Append ¯\\_(ツ)_/¯ to your message',
    run: (args) => tag('shrug', withText(args, SHRUG)),
  },
  {
    name: 'tableflip',
    args: '[text]',
    description: `Append ${TABLEFLIP}`,
    run: (args) => tag('tableflip', withText(args, TABLEFLIP)),
  },
  {
    name: 'unflip',
    args: '[text]',
    description: `Append ${UNFLIP}`,
    run: (args) => tag('unflip', withText(args, UNFLIP)),
  },
  {
    name: 'me',
    args: '<action>',
    description: 'Send an action in italics, e.g. /me waves',
    run: (args) => {
      const t = meText(args);
      if (!t) return usage('/me <action>');
      if (t.length > MAX) return { cancel: true, reason: 'That action is too long.' };
      return tag('me', t);
    },
  },
  {
    name: 'roll',
    args: '[NdM]',
    description: 'Roll dice, e.g. 2d6 or d20+3 (default 1d6)',
    run: (args) => {
      const t = rollText(args);
      if (!t) return usage(`/roll [NdM], e.g. /roll 2d6 (1–${DICE_LIMITS.maxDice} dice, ${DICE_LIMITS.minSides}–${DICE_LIMITS.maxSides} sides)`);
      return tag('roll', t);
    },
  },
  {
    name: 'flip',
    description: 'Flip a coin',
    run: () => tag('flip', `🪙 flipped a coin: **${flipCoin()}**`),
  },
  {
    name: 'spoiler',
    args: '<text>',
    description: 'Send text hidden behind a spoiler',
    run: (args) => {
      const t = spoilerText(args);
      if (!t) return usage('/spoiler <text>');
      if (t.length > MAX) return { cancel: true, reason: 'That spoiler is too long.' };
      return tag('spoiler', t);
    },
  },
  {
    name: 'poll',
    description: 'Create a poll',
    run: (_args, ctx) => {
      openTool(ctx?.conv?.scope, 'poll');
      return { handled: true };
    },
  },
  {
    name: 'gif',
    args: '<search>',
    description: 'Search GIPHY for a GIF',
    run: (args, ctx) => {
      openTool(ctx?.conv?.scope, 'gif', { query: String(args || '').slice(0, 50) });
      return { handled: true };
    },
  },
]);

/** Names a published bot may not use for its own commands. */
export const RESERVED_NAMES = Object.freeze(['help', ...BUILTIN_COMMANDS.map((c) => c.name)]);
