// Premium cosmetics: the stored shape and its validation (pure, no Firebase; unit-tested).
//
// upub/{uid}/premium/look = { tag?, tagA?, tagB?, nameFx?, fxA?, fxB?, cardFx?, banner?, frame? }
// Generic public block (signed-in read, owner write, leaves only). Anyone can write their own block,
// so readers show it ONLY while premium/{uid} is active, and every field is re-validated on read:
// unknown values are dropped, the tag is plain text rendered as React text.

export const TAG_MAX = 24;
export const NAME_FX = ['none', 'gradient', 'glow', 'shimmer', 'rainbow'];
export const CARD_FX = ['none', 'sparkles', 'snow', 'confetti'];
export const BANNERS = ['none', 'aurora', 'gradient', 'starfield', 'frame'];
export const FRAMES = ['none', 'glow', 'gradient', 'rainbow'];

export const NAME_FX_LABEL = { none: 'None', gradient: 'Gradient', glow: 'Glow', shimmer: 'Shimmer', rainbow: 'Rainbow' };
export const CARD_FX_LABEL = { none: 'None', sparkles: 'Sparkles', snow: 'Snow', confetti: 'Confetti' };
export const BANNER_LABEL = { none: 'Standard', aurora: 'Aurora', gradient: 'Animated gradient', starfield: 'Starfield', frame: 'Standard with animated frame' };
export const FRAME_LABEL = { none: 'None', glow: 'Glow ring', gradient: 'Gradient ring', rainbow: 'Rainbow ring' };

export const DEFAULT_A = '#8b5cf6';
export const DEFAULT_B = '#ec4899';

const HEX = /^#[0-9a-f]{6}$/i;
// Control characters, bidi overrides/isolates and zero-width joiners other than ZWJ (emoji need it).
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f​‎‏‪-‮⁦-⁩﻿]/g;
const LINKISH = /(https?:|www\.|<|>|\b[a-z0-9-]+\.(com|net|org|io|dev|app|gg|xyz|ru|cn)\b)/i;

/** Number of user-perceived characters (code points; good enough for a 24-character cap). */
export const tagLength = (s) => Array.from(String(s || '')).length;

/** Cleaned tag text, or '' (empty / only spaces). */
export function cleanTag(s) {
  return String(s ?? '').replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim();
}

/** Human error for a tag the editor shouldn't save, else null. */
export function tagProblem(s) {
  const t = cleanTag(s);
  if (tagLength(t) > TAG_MAX) return `A role tag is at most ${TAG_MAX} characters`;
  if (LINKISH.test(t)) return 'Links and HTML are not allowed in a role tag';
  return null;
}

const pick = (v, list) => (typeof v === 'string' && list.includes(v) ? v : 'none');
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);

/**
 * A stored (untrusted) look -> the values to render. Always returns every key; 'none' / null / '' mean
 * "off". A tag that is too long or link-like is dropped.
 */
export function normalizeLook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tag = cleanTag(typeof r.tag === 'string' ? r.tag : '');
  return {
    tag: tag && !tagProblem(tag) ? tag : '',
    tagA: hex(r.tagA) || DEFAULT_A,
    tagB: hex(r.tagB),
    nameFx: pick(r.nameFx, NAME_FX),
    fxA: hex(r.fxA) || DEFAULT_A,
    fxB: hex(r.fxB) || DEFAULT_B,
    cardFx: pick(r.cardFx, CARD_FX),
    banner: pick(r.banner, BANNERS),
    frame: pick(r.frame, FRAMES),
  };
}

/** Whether a normalized look shows anything. */
export function hasLook(l) {
  return !!l && (!!l.tag || l.nameFx !== 'none' || l.cardFx !== 'none' || l.banner !== 'none' || l.frame !== 'none');
}

/**
 * Editor values -> the exact object to store (leaves only, as the upub rules require). Throws an Error
 * with a readable message for an invalid tag.
 */
export function lookRecord(input) {
  const bad = tagProblem(input?.tag);
  if (bad) throw new Error(bad);
  const l = normalizeLook({ ...input, tag: cleanTag(input?.tag) });
  const out = { nameFx: l.nameFx, fxA: l.fxA, fxB: l.fxB, cardFx: l.cardFx, banner: l.banner, frame: l.frame, tagA: l.tagA };
  if (l.tag) out.tag = l.tag;
  if (l.tagB) out.tagB = l.tagB;
  return out;
}

/** Inline style for the role tag: one colour or a two-colour gradient, with readable text. */
export function tagStyle(l) {
  const a = l.tagA || DEFAULT_A;
  const bg = l.tagB ? `linear-gradient(90deg, ${a}, ${l.tagB})` : a;
  return { background: bg, color: readableOn(a, l.tagB) };
}

function lum(h) {
  const n = parseInt(h.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** '#ffffff' or '#111111', whichever reads better on the (average of the) background colour(s). */
export function readableOn(a, b) {
  const L = b ? (lum(a) + lum(b)) / 2 : lum(a);
  return L > 0.4 ? '#111111' : '#ffffff';
}
