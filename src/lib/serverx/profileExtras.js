// Richer profiles. users/{uid}/profile = { bio<=190, pronouns<=40, links[<=3] (https only), banner '#rrggbb' }.
// Public plaintext by design (same visibility as users/{uid}/name). Read via useProfile(uid).profile.
import { ref, remove, set } from 'firebase/database';
import { db } from '../firebase.js';

export const MAX_BIO = 190;
export const MAX_PRONOUNS = 40;
export const MAX_LINKS = 3;
export const MAX_LINK_LEN = 200;
export const BANNER_COLORS = ['#5b8cff', '#a66bff', '#ff6b9a', '#ff8f4d', '#f5c542', '#3ccf91', '#2bc4d9', '#8892a6'];

export const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

/** Normalizes a user-entered link to a canonical https URL, or null when unusable. */
export function cleanLink(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
    const out = u.href;
    return out.length <= MAX_LINK_LEN && !/\s/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Clean + clamp an arbitrary draft to the stored shape. Empty fields are omitted. */
export function cleanExtras(d = {}) {
  const out = {};
  const bio = String(d.bio || '').replace(/\r/g, '').trim().slice(0, MAX_BIO);
  if (bio) out.bio = bio;
  const pronouns = String(d.pronouns || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PRONOUNS);
  if (pronouns) out.pronouns = pronouns;
  const links = (Array.isArray(d.links) ? d.links : []).map(cleanLink).filter(Boolean).slice(0, MAX_LINKS);
  if (links.length) out.links = links;
  if (isHex(d.banner)) out.banner = d.banner.toLowerCase();
  return out;
}

/** Defensive read of someone else's profile node (never trust the stored shape). */
export function readExtras(profile) {
  const p = profile?.profile;
  if (!p || typeof p !== 'object') return {};
  const links = Array.isArray(p.links) ? p.links : p.links && typeof p.links === 'object' ? Object.values(p.links) : [];
  return cleanExtras({ ...p, links });
}

export const hasExtras = (x) => !!(x && (x.bio || x.pronouns || x.links?.length || x.banner));

export async function saveExtras(uid, draft) {
  const clean = cleanExtras(draft);
  if (!hasExtras(clean)) {
    await remove(ref(db, `users/${uid}/profile`));
    return {};
  }
  await set(ref(db, `users/${uid}/profile`), clean);
  return clean;
}
