// GIF picker (feature 10). Hidden entirely when appConfig/giphyKey is absent. GIFs are links only.
import { useEffect, useRef, useState } from 'react';
import { isGiphyUrl, searchGifs, trendingGifs, useGiphyKey } from '../../lib/media/giphy.js';
import { errMsg, normalizeGif } from './util.js';

const PAGE = 24;

/** Toggle-button + popover. onPick receives { url, w, h } (validated GIPHY URL). initialQuery prefills the search. */
export function GifPicker({ onPick, onClose, initialQuery = '' }) {
  const key = useGiphyKey();
  const [q, setQ] = useState(() => String(initialQuery || '').slice(0, 50));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (!key) return undefined;
    const my = ++seq.current;
    const term = q.trim();
    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const res = term ? await searchGifs(term) : await trendingGifs();
        if (my !== seq.current) return;
        const list = (Array.isArray(res) ? res : res?.data || []).map(normalizeGif).filter((g) => g && isGiphyUrl(g.url));
        setItems(list);
      } catch (e) {
        if (my === seq.current) setError(errMsg(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    }, term ? 350 : 0);
    return () => clearTimeout(t);
  }, [key, q]);

  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  if (!key) return null;
  return (
    <div className="md-gif" role="dialog" aria-label="GIF picker">
      <input className="md-gif-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search GIPHY" aria-label="Search GIFs" />
      <div className="md-gif-grid">
        {items.map((g) => (
          <button key={g.id} type="button" className="md-gif-item" onClick={() => onPick?.({ url: g.url, w: g.w, h: g.h })} style={{ aspectRatio: `${g.w} / ${g.h}` }}>
            <img src={isGiphyUrl(g.preview) ? g.preview : g.url} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />
          </button>
        ))}
      </div>
      {loading && <p className="md-hint">Loading…</p>}
      {!loading && !error && items.length === 0 && <p className="md-hint">No GIFs found.</p>}
      {error && <p className="md-error" role="alert">{error}</p>}
      <p className="md-gif-credit">Powered by GIPHY. GIPHY sees your IP and search terms.</p>
    </div>
  );
}

/** Render a message's `gif: { url, w, h }`. Nothing is requested unless the URL passes the GIPHY host check. */
export function GifMessage({ gif }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  const ok = !!gif && isGiphyUrl(gif.url);
  useEffect(() => {
    if (!ok || seen || !ref.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [ok, seen]);
  if (!ok) return null;
  const w = Math.min(Math.max(+gif.w || 200, 1), 320);
  const h = Math.round(w * ((+gif.h || 200) / (+gif.w || 200)));
  return (
    <div ref={ref} className="md-gifmsg" style={{ width: w, aspectRatio: `${w} / ${h}` }}>
      {seen && <img src={gif.url} alt="GIF" referrerPolicy="no-referrer" loading="lazy" draggable={false} />}
      <span className="md-gifmsg-tag">GIPHY</span>
    </div>
  );
}

/** Convenience for the composer: whether to show the GIF button at all. */
export function useGifEnabled() {
  return !!useGiphyKey();
}
