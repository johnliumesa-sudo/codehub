// Profile link normalisation, kept free of Firebase so unit tests can import it.
// LINK_RE is the same pattern database.rules.json enforces on users/{uid}/profile/links/{i}
// (tests/unit/pure.test.mjs checks the two stay identical).
export const MAX_LINK_LEN = 200;
export const LINK_RE = /^https:\/\/[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+(:[0-9]+)?([\/?#][^ ]*)?$/;

/** Normalizes a user-entered link to a canonical https URL, or null when unusable. */
export function cleanLink(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
    const out = u.href;
    return out.length <= MAX_LINK_LEN && !/\s/.test(out) && LINK_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}
