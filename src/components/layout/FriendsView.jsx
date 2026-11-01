import { useEffect, useMemo, useState } from 'react';
import { acceptFriend, addFriend, removeFriend } from '../../lib/friends.js';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import { searchUsersByName } from './modals.jsx';
import { Avatar, Icon, PRESENCE_LABEL, useToast } from './ui.jsx';

const errMsg = (e) => e?.message?.replace(/^Firebase:\s*/, '') || 'Something went wrong';

/**
 * Home screen when no DM is open: friends list, pending requests and "add friend".
 * props: me, friends (from useFriends), onMessage(uid)
 */
export default function FriendsView({ me, friends, onMessage }) {
  const toast = useToast();
  const incoming = friends.list.filter((f) => f.state === 'in');
  const [tab, setTab] = useState(incoming.length ? 'pending' : 'online');
  const uids = useMemo(() => friends.list.map((f) => f.uid), [friends.list]);
  const profiles = useProfiles(uids);
  const presence = usePresences(uids);
  const [busy, setBusy] = useState(null);

  const act = async (uid, fn, ok) => {
    setBusy(uid);
    try {
      await fn(me.uid, uid);
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const accepted = friends.list.filter((f) => f.state === 'friends');
  const byName = (a, b) => (profiles[a.uid]?.name || '').localeCompare(profiles[b.uid]?.name || '');
  const lists = {
    online: accepted.filter((f) => (presence[f.uid] || 'offline') !== 'offline').sort(byName),
    all: [...accepted].sort(byName),
    pending: friends.list.filter((f) => f.state !== 'friends').sort((a, b) => (a.state === 'in' ? -1 : 1) - (b.state === 'in' ? -1 : 1) || b.ts - a.ts),
  };

  const tabs = [
    ['online', 'Online'],
    ['all', 'All'],
    ['pending', 'Pending', incoming.length],
  ];

  return (
    <div className="fr-root">
      <div className="fr-head">
        <div className="fr-tabs" role="tablist">
          {tabs.map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`fr-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {label}
              {n > 0 && <span className="fr-badge">{n}</span>}
            </button>
          ))}
          <button role="tab" aria-selected={tab === 'add'} className={`fr-tab add ${tab === 'add' ? 'on' : ''}`} onClick={() => setTab('add')}>
            Add friend
          </button>
        </div>
      </div>

      <div className="fr-body">
        {tab === 'add' ? (
          <AddFriend me={me} friends={friends} />
        ) : (
          <>
            <div className="fr-count">{tab === 'pending' ? 'Pending' : tab === 'online' ? 'Online' : 'All friends'} — {lists[tab].length}</div>
            {lists[tab].map((f) => {
              const p = profiles[f.uid];
              const pres = presence[f.uid] || 'offline';
              const sub = f.state === 'in' ? 'Incoming friend request' : f.state === 'out' ? 'Outgoing friend request' : p?.status || PRESENCE_LABEL[pres];
              return (
                <div key={f.uid} className="fr-row">
                  <Avatar profile={p} size={36} presence={pres} ring="var(--bg-1)" />
                  <span className="ly-dm-text">
                    <span className="ly-dm-name">{p?.name || '…'}</span>
                    <span className="ly-dm-status">{sub}</span>
                  </span>
                  <span className="fr-actions">
                    {f.state === 'friends' && (
                      <button className="fr-act" title="Message" aria-label="Message" onClick={() => onMessage(f.uid)}>
                        <Icon name="message" size={17} />
                      </button>
                    )}
                    {f.state === 'in' && (
                      <button className="fr-act ok" title="Accept" aria-label="Accept" disabled={busy === f.uid}
                        onClick={() => act(f.uid, acceptFriend, `You and ${p?.name || 'they'} are now friends`)}>
                        <Icon name="check" size={17} />
                      </button>
                    )}
                    <button
                      className="fr-act danger"
                      title={f.state === 'friends' ? 'Remove friend' : f.state === 'in' ? 'Decline' : 'Cancel request'}
                      aria-label={f.state === 'friends' ? 'Remove friend' : f.state === 'in' ? 'Decline' : 'Cancel request'}
                      disabled={busy === f.uid}
                      onClick={() => act(f.uid, removeFriend)}
                    >
                      <Icon name="x" size={17} />
                    </button>
                  </span>
                </div>
              );
            })}
            {!friends.loading && lists[tab].length === 0 && (
              <div className="fr-empty">
                <p className="muted">
                  {tab === 'pending' ? 'No pending friend requests.' : tab === 'online' ? 'No friends are online right now.' : "You haven't added any friends yet."}
                </p>
                {tab !== 'pending' && <button className="btn primary sm" onClick={() => setTab('add')}><Icon name="userPlus" size={15} /> Add friend</button>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddFriend({ me, friends }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ q: '', list: [], loading: false, error: null });
  const [busy, setBusy] = useState(null);
  const state = useMemo(() => Object.fromEntries(friends.list.map((f) => [f.uid, f.state])), [friends.list]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setRes({ q: term, list: [], loading: false, error: null });
    let alive = true;
    setRes((r) => ({ ...r, loading: true }));
    const t = setTimeout(() => {
      searchUsersByName(term).then(
        (list) => alive && setRes({ q: term, list: list.filter((p) => p.uid !== me.uid), loading: false, error: null }),
        (error) => alive && setRes({ q: term, list: [], loading: false, error }),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, me.uid]);

  const presence = usePresences(res.list.map((p) => p.uid));

  const add = async (p) => {
    setBusy(p.uid);
    try {
      const st = await addFriend(me.uid, p.uid);
      toast(st === 'friends' ? `You and ${p.name} are now friends` : `Friend request sent to ${p.name}`, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fr-add">
      <h3>Add friend</h3>
      <p className="muted">Search for people by their display name and send them a friend request.</p>
      <div className="ly-search-box big">
        <Icon name="search" size={16} />
        <input className="ly-search-input" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search people by name" />
        {res.loading && <span className="spinner ly-spinner-sm" />}
      </div>
      <div className="fr-results">
        {res.list.map((p) => {
          const st = state[p.uid];
          return (
            <div key={p.uid} className="fr-row">
              <Avatar profile={p} size={36} presence={presence[p.uid] || 'offline'} ring="var(--bg-1)" />
              <span className="ly-dm-text">
                <span className="ly-dm-name">{p.name || 'Unnamed'}</span>
                {p.status && <span className="ly-dm-status">{p.status}</span>}
              </span>
              {st === 'friends' ? (
                <span className="fr-tag">Friends</span>
              ) : st === 'out' ? (
                <span className="fr-tag">Request sent</span>
              ) : (
                <button className="btn primary sm" disabled={busy === p.uid} onClick={() => add(p)}>
                  {st === 'in' ? 'Accept request' : 'Send request'}
                </button>
              )}
            </div>
          );
        })}
        {q.trim().length >= 2 && !res.loading && res.list.length === 0 && (
          <p className="muted fr-empty">{res.error ? 'Search is unavailable right now.' : 'Nobody found with that name.'}</p>
        )}
      </div>
    </div>
  );
}
