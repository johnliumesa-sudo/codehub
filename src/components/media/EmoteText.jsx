// Custom server emotes for chat: the per-server lookup used by message text (lib/markdown.js renders
// `:name:` as an <img>), reactions, the emoji picker's "Server" category and composer autocomplete.
import { useMemo } from 'react';
import { useEmotes } from '../../lib/media/emotes.js';
import { normalizeEmotes } from './util.js';

const NONE = Object.freeze({ list: Object.freeze([]), map: new Map() });

/** { list: [{ id, name, src }] sorted by name, map: Map name -> src } for a server; empty for sid=null (DMs/groups). */
export function useServerEmotes(sid) {
  const raw = useEmotes(sid);
  return useMemo(() => {
    const list = normalizeEmotes(raw);
    return list.length ? { list, map: new Map(list.map((e) => [e.name, e.src])) } : NONE;
  }, [raw]);
}

/** { name -> src } for a server. Pass sid=null for DMs/groups (no custom emotes). */
export function useEmoteMap(sid) {
  return useServerEmotes(sid).map;
}

export function Emote({ name, src, size = 22 }) {
  return <img className="md-emote" src={src} alt={`:${name}:`} title={`:${name}:`} width={size} height={size} loading="lazy" draggable={false} />;
}
