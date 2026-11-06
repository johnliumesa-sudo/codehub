// :name: rendering (messages and reactions) plus the "Server" tab for the emoji picker.
import { Fragment, useMemo } from 'react';
import { useEmotes } from '../../lib/media/emotes.js';
import { normalizeEmotes } from './util.js';

/** { name -> src } for a server. Pass sid=null for DMs/groups (no custom emotes). */
export function useEmoteMap(sid) {
  const raw = useEmotes(sid);
  return useMemo(() => new Map(normalizeEmotes(raw).map((e) => [e.name, e.src])), [raw]);
}

export function Emote({ name, src, size = 22 }) {
  return <img className="md-emote" src={src} alt={`:${name}:`} title={`:${name}:`} width={size} height={size} loading="lazy" draggable={false} />;
}

const EMOTE_TOKEN = /:([a-z0-9_]{2,32}):/g;

/** Split plain text into strings and <Emote/> nodes. Unknown :names: stay literal. */
export function renderEmotes(text, map, size) {
  if (typeof text !== 'string' || !map || map.size === 0 || !text.includes(':')) return text;
  const out = [];
  let last = 0;
  let m;
  EMOTE_TOKEN.lastIndex = 0;
  while ((m = EMOTE_TOKEN.exec(text))) {
    const src = map.get(m[1]);
    if (!src) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<Emote key={out.length} name={m[1]} src={src} size={size} />);
    last = m.index + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out.map((n, i) => (typeof n === 'string' ? <Fragment key={i}>{n}</Fragment> : n));
}

/** <EmoteText sid text="hi :party:" /> or <EmoteText sid>{string}</EmoteText>. Non-strings pass through. */
export function EmoteText({ sid, text, children, size }) {
  const map = useEmoteMap(sid);
  return <>{renderEmotes(text ?? children, map, size)}</>;
}

/** Emoji-picker "Server" tab. onPick receives ":name:" (insert in composer) and the emote object. */
export function EmotePickerTab({ sid, onPick }) {
  const emotes = normalizeEmotes(useEmotes(sid));
  if (!emotes.length) return <p className="md-hint md-picker-empty">This server has no custom emotes.</p>;
  return (
    <div className="md-emote-grid" role="listbox" aria-label="Server emotes">
      {emotes.map((e) => (
        <button key={e.id} type="button" role="option" className="md-emote-pick" title={`:${e.name}:`} onClick={() => onPick?.(`:${e.name}:`, e)}>
          <img src={e.src} alt={`:${e.name}:`} loading="lazy" draggable={false} />
        </button>
      ))}
    </div>
  );
}
