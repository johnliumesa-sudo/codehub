// Safe external links (F13). Pure helpers — no DB.
//
// analyzeLink(href, text) inspects an http(s) link before it is opened: which host it really goes to,
// and whether it looks deceptive (punycode/IDN host, raw IP, plain http, user-info "github.com@evil.tld",
// link text that names a different host). The per-device trusted set lives in localStorage under
// `codehub.trustedDomains` (JSON array of registrable-ish domains).

export const TRUSTED_KEY = 'codehub.trustedDomains';
export const TRUSTED_EVENT = 'codehub:trusted-domains';

// Multi-tenant suffixes where each subdomain belongs to a different owner: trust stops one level below.
const SHARED_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'appspot.com', 'blogspot.com', 'glitch.me', 'repl.co', 'onrender.com', 'fly.dev',
  'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'surge.sh', 'neocities.org', 'codepen.io', 'replit.app',
]);
// Common two-level public suffixes (co.uk, com.au, …): a short label under a 2-letter ccTLD.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nic', 'mil', 'ltd', 'plc', 'sch']);

const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;

export function isIpHost(hostname) {
  const h = String(hostname || '');
  if (h.startsWith('[') || h.includes(':')) return true; // IPv6 literal
  // WHATWG URL normalises decimal/hex/octal IPv4 forms to dotted quads.
  return IPV4_RE.test(h);
}

/** Registrable-ish domain for trust decisions: example.com, example.co.uk, user.github.io. */
export function registrableDomain(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || isIpHost(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  if (SHARED_SUFFIXES.has(last2)) return labels.slice(-3).join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return labels.slice(-3).join('.');
  return last2;
}

const safeDecode = (v) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

const stripWww = (h) => String(h || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

// Link text that itself looks like a URL or bare domain ("paypal.com/login", "https://github.com").
const TEXTURL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s/@]+@)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

function hostFromText(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2048 || /\s/.test(t)) return null;
  const m = TEXTURL_RE.exec(t);
  if (!m) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname;
  } catch {
    return null;
  }
}

/**
 * @returns {{
 *   ok: boolean,            // a parseable http(s) URL
 *   external: boolean,      // origin differs from the app's
 *   href: string, url: URL|null, protocol: string, hostname: string, port: string, username: string,
 *   domain: string,         // registrable-ish domain (what "Always trust" stores)
 *   warnings: Array<{ code: 'punycode'|'ip'|'insecure'|'userinfo'|'mismatch', severity: 'high'|'medium', text: string }>,
 *   trustable: boolean,     // false when a high-severity warning makes "Always trust" unsafe to offer
 * }}
 */
export function analyzeLink(href, text = '') {
  const base = { ok: false, external: false, href: String(href || ''), url: null, protocol: '', hostname: '', port: '', username: '', domain: '', warnings: [], trustable: false };
  let url;
  try {
    url = new URL(String(href || ''), typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    return base;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ...base, href: url.href, url, protocol: url.protocol };
  const hostname = url.hostname.toLowerCase();
  const external = typeof location === 'undefined' || url.origin !== location.origin;
  const warnings = [];

  if (hostname.split('.').some((l) => l.startsWith('xn--'))) {
    warnings.push({
      code: 'punycode',
      severity: 'high',
      text: 'The address uses internationalized characters (shown as "xn--…"). Such names can imitate a familiar site with look-alike letters.',
    });
  }
  if (isIpHost(hostname)) {
    warnings.push({ code: 'ip', severity: 'high', text: 'The link points to a raw IP address instead of a domain name.' });
  }
  if (url.username || url.password) {
    warnings.push({
      code: 'userinfo',
      severity: 'high',
      text: `Everything before "@" is ignored by the browser — this link really goes to ${hostname}, not ${safeDecode(url.username) || 'the name shown first'}.`,
    });
  }
  if (url.protocol === 'http:') {
    warnings.push({ code: 'insecure', severity: 'medium', text: 'This link is not encrypted (http). Anyone on the network can read or change the page.' });
  }
  const textHost = hostFromText(text);
  if (textHost && stripWww(textHost) !== stripWww(hostname)) {
    warnings.push({
      code: 'mismatch',
      severity: 'high',
      text: `The link text shows "${textHost}" but it actually opens ${hostname}.`,
    });
  }

  return {
    ok: true,
    external,
    href: url.href,
    url,
    protocol: url.protocol,
    hostname,
    port: url.port,
    username: url.username,
    domain: registrableDomain(hostname),
    warnings,
    trustable: !warnings.some((w) => w.severity === 'high'),
  };
}

// ---------- Trusted domains (per device) ----------

export function listTrusted() {
  try {
    const v = JSON.parse(localStorage.getItem(TRUSTED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((d) => typeof d === 'string' && d) : [];
  } catch {
    return [];
  }
}

function saveTrusted(list) {
  try {
    localStorage.setItem(TRUSTED_KEY, JSON.stringify([...new Set(list)].sort()));
  } catch {
    /* storage unavailable: trust lasts only for this click */
  }
  try {
    window.dispatchEvent(new Event(TRUSTED_EVENT));
  } catch {
    /* non-browser */
  }
}

/** True when `hostname` equals a trusted domain or is a subdomain of one. */
export function isTrusted(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return listTrusted().some((d) => h === d || h.endsWith(`.${d}`));
}

/** Add a domain (normally analyzeLink(...).domain) to the trusted set. */
export function trust(domain) {
  const d = String(domain || '').toLowerCase().trim().replace(/\.$/, '');
  if (!d || d.length > 253) return;
  saveTrusted([...listTrusted(), d]);
}

export function untrust(domain) {
  const d = String(domain || '').toLowerCase();
  saveTrusted(listTrusted().filter((x) => x !== d));
}

/**
 * Should a click on this link be intercepted? Trusted domains pass straight through, unless the link
 * carries a high-severity warning (user-info trick, text/host mismatch, …).
 */
export function shouldGuard(info) {
  if (!info?.ok || !info.external) return false;
  if (isTrusted(info.hostname) && info.trustable) return false;
  return true;
}
