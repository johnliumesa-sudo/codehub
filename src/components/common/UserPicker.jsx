// Shared people picker: friends first, then a global prefix search on users/ by name (the same
// query NewDmModal uses). It only reports picks — the caller keeps the selection and passes it back
// through `exclude` so picked people drop out of the list.
//
// Props: { me, exclude = [], onPick(uid), placeholder, friendsFirst = true, requireKey = true, autoFocus = true, disabled }
//   requireKey: people who never unlocked a vault (no public key) are shown but can't be picked,
//   because nothing can be encrypted for them yet.
import { useEffect, useMemo, useState } from 'react';
import { useFriends } from '../../lib/friends.js';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import { searchUsersByName } from '../layout/modals.jsx';
import { Avatar, Icon } from '../layout/ui.jsx';
import './common.css';

const MAX_RESULTS = 50;

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

export default function UserPicker({
  me,
  exclude = [],
  onPick,
  placeholder = 'Search people by name',
  friendsFirst = true,
  requireKey = true,
  autoFocus = true,
  disabled = false,
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [remote, setRemote] = useState({ q: '', list: [], error: null, loading: false });

  const { list: friendLinks } = useFriends(me?.uid);
  const friendUids = useMemo(() => friendLinks.filter((f) => f.state === 'friends').map((f) => f.uid), [friendLinks]);
  const friendProfiles = useProfiles(friendUids);

  useEffect(() => {
    if (dq.length < 2) {
      setRemote({ q: dq, list: [], error: null, loading: false });
      return undefined;
    }
    let alive = true;
    setRemote((r) => ({ ...r, loading: true }));
    searchUsersByName(dq).then(
      (list) => alive && setRemote({ q: dq, list, error: null, loading: false }),
      (error) => alive && setRemote({ q: dq, list: [], error, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [dq]);

  const excluded = useMemo(() => new Set([me?.uid, ...exclude].filter(Boolean)), [me?.uid, exclude.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const { friends, others } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const f = [];
    const seen = new Set();
    friendUids.forEach((uid) => {
      const p = friendProfiles[uid];
      if (!p || p.deleted || excluded.has(uid)) return;
      if (needle && !(p.name || '').toLowerCase().includes(needle)) return;
      f.push({ ...p, uid, friend: true });
      seen.add(uid);
    });
    const o = [];
    if (needle.length >= 2) {
      remote.list.forEach((p) => {
        if (!p?.uid || excluded.has(p.uid) || seen.has(p.uid)) return;
        seen.add(p.uid);
        o.push(p);
      });
    }
    f.sort(byName);
    o.sort(byName);
    return { friends: f, others: o };
  }, [q, friendUids, friendProfiles, remote.list, excluded]);

  const sections = friendsFirst
    ? [
        { key: 'friends', title: 'Friends', list: friends.slice(0, MAX_RESULTS) },
        { key: 'others', title: friends.length ? 'Everyone else' : 'People', list: others.slice(0, Math.max(0, MAX_RESULTS - friends.length)) },
      ]
    : [{ key: 'all', title: null, list: [...friends, ...others].sort(byName).slice(0, MAX_RESULTS) }];

  const shownUids = sections.flatMap((s) => s.list.map((p) => p.uid));
  const presence = usePresences(shownUids);
  const total = shownUids.length;
  const typed = q.trim();

  return (
    <div className="cmn-picker">
      <div className="ly-search-box big cmn-picker-search">
        <Icon name="search" size={16} />
        <input
          className="ly-search-input"
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus={autoFocus}
          aria-label={placeholder}
          disabled={disabled}
        />
        {remote.loading && <span className="spinner ly-spinner-sm" />}
        {q && !remote.loading && (
          <button type="button" className="cmn-picker-clear" onClick={() => setQ('')} aria-label="Clear search">
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div className="cmn-picker-list" role="listbox" aria-label="People">
        {sections.map(
          (s) =>
            s.list.length > 0 && (
              <div key={s.key} className="cmn-picker-section">
                {s.title && <div className="cmn-picker-head">{s.title}</div>}
                {s.list.map((p) => {
                  const noKey = requireKey && !p.pubKey;
                  return (
                    <button
                      type="button"
                      key={p.uid}
                      role="option"
                      aria-selected={false}
                      className={`cmn-picker-row ${noKey ? 'nokey' : ''}`}
                      onClick={() => !noKey && onPick?.(p.uid)}
                      disabled={disabled || noKey}
                      title={noKey ? "Hasn't set up encryption yet" : `Add ${p.name || 'this person'}`}
                    >
                      <Avatar profile={p} size={32} presence={presence[p.uid] || 'offline'} ring="var(--bg-2)" />
                      <span className="cmn-picker-text">
                        <span className="cmn-picker-name">
                          {p.name || 'Unnamed'}
                          {p.friend && <span className="cmn-picker-tag">Friend</span>}
                        </span>
                        <span className="cmn-picker-sub">{noKey ? "Hasn't set up encryption yet" : p.status || ''}</span>
                      </span>
                      {!noKey && <Icon name="plus" size={16} className="cmn-picker-add" />}
                    </button>
                  );
                })}
              </div>
            ),
        )}
        {total === 0 && (
          <p className="muted cmn-picker-empty">
            {typed.length < 2
              ? friendUids.length && !typed
                ? 'Everyone on your friends list is already added.'
                : 'Type at least 2 characters to search everyone.'
              : remote.loading || remote.q !== dq
                ? 'Searching…'
                : 'Nobody found with that name.'}
          </p>
        )}
        {remote.error && typed.length >= 2 && <p className="muted cmn-picker-hint">Global search is unavailable — showing friends only.</p>}
      </div>
    </div>
  );
}
