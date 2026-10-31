// Create/join server, pending invite, channel create/edit, new DM.
import { useEffect, useMemo, useState } from 'react';
import { endAt, get, limitToFirst, orderByChild, query, ref, startAt } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import {
  MAX_CHANNEL_NAME,
  MAX_SERVER_NAME,
  MAX_TOPIC,
  SERVER_COLORS,
  cleanChannelName,
  createChannel,
  createServer,
  deleteChannel,
  joinServer,
  openDm,
  parseInviteLink,
  updateChannel,
} from '../../lib/servers.js';
import { Avatar, ConfirmButton, Icon, Modal, useToast } from './ui.jsx';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

export function ColorPicker({ value, onChange }) {
  return (
    <div className="ly-colors" role="radiogroup" aria-label="Color">
      {SERVER_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={`ly-color ${value === c ? 'on' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={c}
        />
      ))}
    </div>
  );
}

// ---------- Create / join ----------

export function CreateJoinModal({ me, onClose, onCreated, onJoined }) {
  const [mode, setMode] = useState('choose');
  const [name, setName] = useState(`${me.name}'s server`.slice(0, MAX_SERVER_NAME));
  const [color, setColor] = useState(SERVER_COLORS[Math.floor(Math.random() * SERVER_COLORS.length)]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await createServer(me.uid, { name, color });
      onCreated(res);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  const join = async (e) => {
    e.preventDefault();
    const inv = parseInviteLink(link);
    if (!inv) return setError('Paste a full invite link — it looks like …#/join/…');
    setBusy(true);
    setError('');
    try {
      const res = await joinServer(me.uid, inv);
      onJoined(res);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  if (mode === 'choose') {
    return (
      <Modal title="Add a server" onClose={onClose}>
        <p className="muted ly-lead">Servers are end-to-end encrypted: names, channels and messages are encrypted before they leave your device.</p>
        <div className="ly-choice-grid">
          <button className="ly-choice" onClick={() => setMode('create')}>
            <span className="ly-choice-icon"><Icon name="plus" size={22} /></span>
            <span><strong>Create my own</strong><span className="muted">Start fresh with #general and a code workspace</span></span>
          </button>
          <button className="ly-choice" onClick={() => setMode('join')}>
            <span className="ly-choice-icon alt"><Icon name="link" size={22} /></span>
            <span><strong>Join with an invite</strong><span className="muted">Paste a link someone shared with you</span></span>
          </button>
        </div>
      </Modal>
    );
  }

  if (mode === 'create') {
    return (
      <Modal title="Create a server" onClose={onClose}>
        <form onSubmit={create} className="ly-form">
          <div className="ly-server-preview">
            <span className="ly-preview-icon" style={{ background: color }}>{(name.trim()[0] || '?').toUpperCase()}</span>
            <span className="ly-ellipsis">{name.trim() || 'Untitled'}</span>
          </div>
          <label className="field">
            Server name
            <input className="input" value={name} maxLength={MAX_SERVER_NAME} onChange={(e) => setName(e.target.value)} autoFocus required />
          </label>
          <div className="ly-field">
            Color
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="ly-form-actions">
            <button type="button" className="btn ghost" onClick={() => setMode('choose')} disabled={busy}>Back</button>
            <button className="btn primary" disabled={busy || !name.trim()}>
              {busy ? <span className="spinner ly-spinner-sm" /> : 'Create server'}
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Join a server" onClose={onClose}>
      <form onSubmit={join} className="ly-form">
        <label className="field">
          Invite link
          <input
            className="input mono"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…/#/join/…"
            autoFocus
            required
          />
        </label>
        <p className="muted ly-hint">The decryption key is part of the link after “#”, so it never reaches the server. Only open links from people you trust.</p>
        {error && <p className="error-text">{error}</p>}
        <div className="ly-form-actions">
          <button type="button" className="btn ghost" onClick={() => setMode('choose')} disabled={busy}>Back</button>
          <button className="btn primary" disabled={busy || !link.trim()}>
            {busy ? <span className="spinner ly-spinner-sm" /> : 'Join server'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Pending invite (from an opened #/join link) ----------

export function PendingInviteModal({ me, invite, onDone, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      onDone(await joinServer(me.uid, invite));
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="You've been invited" onClose={busy ? undefined : onDismiss}>
      <div className="ly-invite-hero">
        <span className="ly-choice-icon"><Icon name="key" size={24} /></span>
        <p>
          Someone shared an encrypted server invite with you. The server's name stays hidden until you join and decrypt it.
        </p>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="ly-form-actions">
        <button className="btn ghost" onClick={onDismiss} disabled={busy}>Not now</button>
        <button className="btn primary" onClick={accept} disabled={busy}>
          {busy ? <span className="spinner ly-spinner-sm" /> : 'Accept invite'}
        </button>
      </div>
    </Modal>
  );
}

// ---------- Channel create / edit ----------

export function ChannelModal({ sid, channel, initialType = 'text', nextPosition, onClose, onCreated, onDeleted }) {
  const editing = !!channel;
  const [type, setType] = useState(channel?.type || initialType);
  const [name, setName] = useState(channel?.name || '');
  const [topic, setTopic] = useState(channel?.topic || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const slug = cleanChannelName(name);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await updateChannel(sid, channel.cid, { name, topic });
        toast('Channel updated', 'success');
        onClose();
      } else {
        const cid = await createChannel(sid, { type, name, topic, position: nextPosition });
        onCreated({ cid, type });
      }
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? `Edit ${channel.type === 'code' ? 'workspace' : 'channel'}` : 'Create channel'} onClose={onClose}>
      <form onSubmit={submit} className="ly-form">
        {!editing && (
          <div className="ly-type-pick" role="radiogroup">
            {[
              ['text', 'hash', 'Text', 'Messages, code snippets, emoji & reactions'],
              ['code', 'code', 'Code workspace', 'Real-time collaborative editor + GitHub'],
            ].map(([t, icon, label, desc]) => (
              <button type="button" key={t} role="radio" aria-checked={type === t} className={`ly-type ${type === t ? 'on' : ''}`} onClick={() => setType(t)}>
                <Icon name={icon} size={20} />
                <span><strong>{label}</strong><span className="muted">{desc}</span></span>
                <span className="ly-radio" />
              </button>
            ))}
          </div>
        )}
        <label className="field">
          Name
          <div className="ly-input-icon">
            <Icon name={type === 'code' ? 'code' : 'hash'} size={16} />
            <input className="input" value={name} maxLength={MAX_CHANNEL_NAME + 10} onChange={(e) => setName(e.target.value)} placeholder={type === 'code' ? 'frontend' : 'new-channel'} autoFocus required />
          </div>
        </label>
        {name && slug !== name && <p className="muted ly-hint">Will be saved as <code>{slug || '—'}</code></p>}
        <label className="field">
          Topic <span className="ly-optional">optional</span>
          <textarea className="input" rows={2} value={topic} maxLength={MAX_TOPIC} onChange={(e) => setTopic(e.target.value)} placeholder="What's this channel about?" />
        </label>
        <p className="muted ly-hint"><Icon name="lock" size={12} /> Name and topic are encrypted with the server key.</p>
        {error && <p className="error-text">{error}</p>}
        <div className="ly-form-actions">
          {editing && (
            <ConfirmButton
              className="btn danger"
              confirmLabel="Delete forever?"
              onConfirm={async () => {
                try {
                  await deleteChannel(sid, channel.cid);
                  toast('Channel deleted', 'success');
                  onDeleted?.(channel.cid);
                } catch (err) {
                  setError(errMsg(err));
                }
              }}
            >
              <Icon name="trash" size={15} /> Delete
            </ConfirmButton>
          )}
          <span className="ly-grow" />
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !slug}>
            {busy ? <span className="spinner ly-spinner-sm" /> : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- New DM ----------

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Prefix search on users/ ordered by name (needs `.indexOn: ["name"]` and read on users/).
async function searchUsersByName(q) {
  const variants = [...new Set([q, q.toLowerCase(), q[0].toUpperCase() + q.slice(1)])];
  const out = {};
  await Promise.all(
    variants.map(async (v) => {
      const s = await get(query(ref(db, 'users'), orderByChild('name'), startAt(v), endAt(`${v}`), limitToFirst(20)));
      s.forEach((c) => {
        out[c.key] = { uid: c.key, ...c.val() };
      });
    }),
  );
  return Object.values(out);
}

export function NewDmModal({ me, serverIds, onClose, onOpen }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [known, setKnown] = useState([]); // uids sharing a server with me
  const [remote, setRemote] = useState({ q: '', list: [], error: null, loading: false });
  const [busyUid, setBusyUid] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.allSettled(serverIds.map((sid) => get(ref(db, `servers/${sid}/members`)))).then((res) => {
      if (!alive) return;
      const s = new Set();
      res.forEach((r) => r.status === 'fulfilled' && Object.keys(r.value.val() || {}).forEach((u) => s.add(u)));
      s.delete(me.uid);
      setKnown([...s]);
    });
    return () => {
      alive = false;
    };
  }, [serverIds.join(','), me.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (dq.length < 2) return setRemote({ q: dq, list: [], error: null, loading: false });
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

  const knownProfiles = useProfiles(known);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map();
    known.forEach((uid) => {
      const p = knownProfiles[uid];
      if (!p) return;
      if (!needle || (p.name || '').toLowerCase().includes(needle)) map.set(uid, { ...p, shared: true });
    });
    if (needle.length >= 2) remote.list.forEach((p) => p.uid !== me.uid && !map.has(p.uid) && map.set(p.uid, p));
    return [...map.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 50);
  }, [q, known, knownProfiles, remote.list, me.uid]);
  const presence = usePresences(results.map((r) => r.uid));

  const open = async (uid) => {
    setBusyUid(uid);
    setError('');
    try {
      onOpen(await openDm(me.uid, uid), uid);
    } catch (e) {
      setError(errMsg(e));
      setBusyUid(null);
    }
  };

  return (
    <Modal title="New message" onClose={onClose}>
      <div className="ly-search-box big">
        <Icon name="search" size={16} />
        <input className="ly-search-input" placeholder="Search people by name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {remote.loading && <span className="spinner ly-spinner-sm" />}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="ly-people">
        {!q && known.length > 0 && <div className="ly-people-head">People from your servers</div>}
        {results.map((p) => (
          <button key={p.uid} className="ly-person" onClick={() => open(p.uid)} disabled={!!busyUid}>
            <Avatar profile={p} size={36} presence={presence[p.uid] || 'offline'} ring="var(--bg-2)" />
            <span className="ly-dm-text">
              <span className="ly-dm-name">{p.name || 'Unnamed'}</span>
              <span className="ly-dm-status">{p.status || (p.shared ? 'Shares a server with you' : '')}</span>
            </span>
            {busyUid === p.uid ? <span className="spinner ly-spinner-sm" /> : <Icon name="message" size={16} />}
          </button>
        ))}
        {results.length === 0 && (
          <p className="muted ly-people-empty">
            {q.trim().length < 2 ? (known.length ? 'No matches' : 'Type at least 2 characters to search everyone.') : remote.loading ? 'Searching…' : 'Nobody found with that name.'}
          </p>
        )}
        {remote.error && q.trim().length >= 2 && <p className="muted ly-hint">Global search is unavailable — showing people from your servers only.</p>}
      </div>
      <p className="muted ly-hint"><Icon name="lock" size={12} /> DMs are encrypted with a key only you and the other person can derive.</p>
    </Modal>
  );
}
