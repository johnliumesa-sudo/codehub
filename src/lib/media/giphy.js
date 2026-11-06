// GIPHY client. The API key lives in appConfig/giphyKey (admin-set, readable by any signed-in user;
// client-visible by nature). GIFs are links only: body.gif = { url, w, h }, and only URLs on
// https://media*.giphy.com/ are ever sent or rendered. GIPHY sees the viewer's IP and search terms.
import { createSharedStore, useShared } from './cache.js';

const API = 'https://api.giphy.com/v1/gifs';
const GIPHY_URL_RE = /^https:\/\/media[0-9]*\.giphy\.com\/[^\s"'<>]*$/;
const KEY_RE = /^[A-Za-z0-9]{8,64}$/;

export const isGiphyUrl = (url) => typeof url === 'string' && url.length <= 512 && GIPHY_URL_RE.test(url);

const keyStore = createSharedStore(
  () => 'appConfig/giphyKey',
  (raw) => (typeof raw === 'string' && KEY_RE.test(raw) ? raw : null),
);

/** The configured GIPHY key, or null (hide the GIF picker). */
export function useGiphyKey() {
  return useShared(keyStore, 'k');
}

/** Validated { url, w, h } for a message body, or null. */
export function cleanGif(gif) {
  if (!gif || !isGiphyUrl(gif.url)) return null;
  const dim = (v) => Math.max(1, Math.min(2000, Number(v) | 0));
  return { url: gif.url, w: dim(gif.w), h: dim(gif.h) };
}

function mapResult(g) {
  const full = g?.images?.fixed_height || g?.images?.downsized || g?.images?.original;
  const prev = g?.images?.fixed_width_small || g?.images?.fixed_height_small || full;
  const gif = cleanGif({ url: full?.url, w: full?.width, h: full?.height });
  if (!gif) return null;
  const preview = cleanGif({ url: prev?.url, w: prev?.width, h: prev?.height }) || gif;
  return { id: String(g.id || gif.url), title: String(g.title || '').slice(0, 140), ...gif, preview };
}

async function call(endpoint, params, signal) {
  const key = await keyStore.read('k');
  if (!key) throw new Error('GIFs are not configured');
  const qs = new URLSearchParams({ api_key: key, rating: 'pg-13', limit: '24', ...params });
  const res = await fetch(`${API}/${endpoint}?${qs}`, { signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
  if (!res.ok) throw new Error(res.status === 429 ? 'GIPHY rate limit reached; try again later' : 'GIPHY request failed');
  const json = await res.json();
  return (Array.isArray(json?.data) ? json.data : []).map(mapResult).filter(Boolean);
}

/** [{ id, title, url, w, h, preview: { url, w, h } }] */
export function searchGifs(q, { offset = 0, signal } = {}) {
  const term = String(q || '').trim().slice(0, 50);
  if (!term) return trendingGifs({ offset, signal });
  return call('search', { q: term, offset: String(offset) }, signal);
}

export function trendingGifs({ offset = 0, signal } = {}) {
  return call('trending', { offset: String(offset) }, signal);
}
