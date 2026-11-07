// Server discovery: the public "Discover" view and the owner's "Discovery" settings tab.
import { useEffect, useId, useMemo, useState } from 'react';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { useIsAppAdmin } from '../../../lib/admin.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import {
  LISTING_COLORS, LISTING_LIMITS, cleanListing, filterListings, listingJoinHash, parseTags, topTags,
} from '../lib/discovery.js';
import { adminRemoveListing, publishListing, unlistServer, useListing, useListings } from '../lib/data.js';
import { useLive } from '../lib/live.js';
import { closeDiscover } from '../lib/bus.js';
import { PortalModal, errText } from './common.jsx';

function ListingTile({ l, size = 44 }) {
  return <span className="cm-tile" style={{ background: l.color, width: size, height: size }} aria-hidden="true">{l.glyph}</span>;
}

/** The public directory (modal), opened from "Add a server" in the server rail or the palette. */
export function DiscoverModal({ onClose }) {
  const ws = useWorkspaceCtx();
  const isAdmin = useIsAppAdmin();
  const { list, loading, error } = useListings();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('members');
  const [busy, setBusy] = useState('');
  const shown = useMemo(() => filterListings(list, { q, tag, sort }), [list, q, tag, sort]);
  const tags = useMemo(() => topTags(list), [list]);
  const mine = new Set((ws?.servers || []).map((s) => s.sid));
  const searchId = useId();

  const open = (l) => {
    onClose();
    ws.setNav((n) => ({ ...n, sid: l.sid, dmId: null, gid: null, view: null }));
  };
  // The existing invite flow: the app picks up #/join/... and asks to accept.
  const join = (l) => {
    onClose();
    location.hash = listingJoinHash(l);
  };
  const remove = async (l) => {
    setBusy(l.sid);
    try {
      await adminRemoveListing(l.sid);
      ws.toast('Listing removed', 'success');
    } catch (e) {
      ws.toast(errText(e), 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <PortalModal title="Discover servers" onClose={onClose} wide className="cm-modal cm-discover">
      <p className="muted cm-hint">
        These servers were listed by their owners. Joining one gives you its key: everyone in a public server can read all of its messages.
      </p>
      <div className="cm-discover-bar">
        <label className="cm-search" htmlFor={searchId}>
          <span className="cm-sr">Search servers</span>
          <input id={searchId} className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, topic or tag" />
        </label>
        <label className="cm-sort">
          <span className="cm-sr">Sort</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
            <option value="members">Most members</option>
            <option value="new">Recently updated</option>
          </select>
        </label>
      </div>
      {tags.length > 0 && (
        <div className="cm-tags" role="group" aria-label="Filter by tag">
          <button type="button" className={`cm-tag${tag ? '' : ' on'}`} aria-pressed={!tag} onClick={() => setTag('')}>All</button>
          {tags.map(({ tag: t, n }) => (
            <button key={t} type="button" className={`cm-tag${tag === t ? ' on' : ''}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>
              {t} <span className="muted">{n}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-text">Couldn't load the directory.</p>}
      {loading && !list.length && <p className="muted cm-empty">Loading…</p>}
      {!loading && !shown.length && <p className="muted cm-empty">{list.length ? 'No servers match.' : 'No public servers yet.'}</p>}
      <ul className="cm-listings">
        {shown.map((l) => (
          <li key={l.sid} className="cm-listing">
            <ListingTile l={l} />
            <div className="cm-listing-text">
              <strong className="cm-listing-name">{l.name}</strong>
              {l.desc && <p className="cm-listing-desc">{l.desc}</p>}
              <div className="cm-listing-meta">
                <span>{l.members} member{l.members === 1 ? '' : 's'}</span>
                {l.tags.map((t) => (
                  <button key={t} type="button" className="cm-tag sm" onClick={() => setTag(t)} aria-label={`Filter by tag ${t}`}>{t}</button>
                ))}
              </div>
            </div>
            <div className="cm-listing-actions">
              {mine.has(l.sid)
                ? <button type="button" className="btn sm" onClick={() => open(l)}>Open</button>
                : <button type="button" className="btn primary sm" onClick={() => join(l)} aria-label={`Join ${l.name}`}>Join</button>}
              {isAdmin && (
                <ConfirmButton className="btn ghost sm cm-danger" confirmLabel="Remove?" onConfirm={() => remove(l)} disabled={busy === l.sid}>Remove listing</ConfirmButton>
              )}
            </div>
          </li>
        ))}
      </ul>
    </PortalModal>
  );
}

/** serverCreateOptions 'community.discover': hands over to the Discover modal. */
export function DiscoverRedirect({ ctx, open }) {
  useEffect(() => {
    ctx.close();
    open();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <p className="muted">Opening Discover…</p>;
}

/** serverSettingsTabs 'community.discovery': list / update / unlist (owner only). */
export function DiscoverySettings({ ctx }) {
  const { sid, server } = ctx;
  const isOwner = server?.myRole === 'owner';
  const { listing, loading } = useListing(sid);
  const invite = useLive(listing?.iid && isOwner ? `servers/${sid}/invites/${listing.iid}` : null);
  const memberCount = server?.members?.length || 0;
  const [form, setForm] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const uid = useId();

  useEffect(() => {
    if (loading || form) return;
    setForm(listing
      ? { name: listing.name, desc: listing.desc, tags: listing.tags.join(', '), glyph: listing.glyph, color: listing.color }
      : { name: server?.meta?.name || '', desc: '', tags: '', glyph: (server?.meta?.name || '?').slice(0, 1).toUpperCase(), color: LISTING_COLORS.includes(server?.meta?.color) ? server.meta.color : LISTING_COLORS[0] });
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the public member count fresh while the owner looks at this tab.
  useEffect(() => {
    if (!isOwner || !listing || !memberCount || listing.members === memberCount) return;
    publishListing(sid, { ...listing, tags: listing.tags, members: memberCount }, { current: listing }).catch(() => {});
  }, [isOwner, listing?.members, memberCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOwner) {
    return (
      <div className="cm-settings">
        <p>{loading ? 'Loading…' : listing ? `This server is listed publicly as “${listing.name}”.` : 'This server is not listed publicly.'}</p>
        <p className="muted">Only the server owner can list or unlist it.</p>
      </div>
    );
  }
  if (!form) return <p className="muted">Loading…</p>;
  const inviteGone = !!listing && !invite.loading && !invite.value;
  let preview = null;
  try {
    preview = cleanListing({ ...form, members: memberCount });
  } catch { /* incomplete form */ }

  const act = async (fn, okText) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    act(() => publishListing(sid, { ...form, members: memberCount }, { current: listing }), listing ? 'Listing updated' : 'Your server is now listed in Discover');
  };

  return (
    <form className="cm-settings" onSubmit={submit}>
      <div className="cm-warn" role="note">
        <strong>Listing publishes an invite.</strong> Anyone signed in to Codehub can find this server, join it and read every
        message, including older ones. The name, description and tags below are public and not encrypted. Unlisting revokes that
        invite, but people who already joined stay members.
      </div>
      {listing && (
        <p className="cm-stat">
          ✅ Listed in Discover · {listing.members} member{listing.members === 1 ? '' : 's'} shown
          {inviteGone && <span className="error-text"> · its invite was revoked, so nobody can join. Save to create a new one.</span>}
        </p>
      )}
      <label className="field">
        Public name
        <input className="input" value={form.name} maxLength={LISTING_LIMITS.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </label>
      <label className="field">
        Description
        <textarea className="input cm-textarea" rows={3} maxLength={LISTING_LIMITS.desc} value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} required />
      </label>
      <label className="field">
        Tags <span className="muted">(comma separated, up to {LISTING_LIMITS.tags})</span>
        <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="rust, game-dev, beginners" />
      </label>
      <div className="cm-row2">
        <label className="field">
          Icon <span className="muted">(an emoji or letters)</span>
          <input className="input" value={form.glyph} maxLength={16} onChange={(e) => setForm({ ...form, glyph: e.target.value })} />
        </label>
        <div className="ly-field">
          Color
          <div className="cm-swatches" role="radiogroup" aria-label="Listing color">
            {LISTING_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={form.color === c} aria-label={c} className={`cm-swatch${form.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setForm({ ...form, color: c })} />
            ))}
          </div>
        </div>
      </div>
      {preview && (
        <div className="cm-listing cm-listing-preview" aria-label="Preview">
          <ListingTile l={preview} />
          <div className="cm-listing-text">
            <strong className="cm-listing-name">{preview.name}</strong>
            <p className="cm-listing-desc">{preview.desc}</p>
            <div className="cm-listing-meta"><span>{memberCount} members</span>{parseTags(form.tags).map((t) => <span key={t} className="cm-tag sm">{t}</span>)}</div>
          </div>
        </div>
      )}
      {!listing && (
        <label className="cm-check">
          <input id={`${uid}-agree`} type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          I understand that anyone can join this server and read all of its messages.
        </label>
      )}
      {msg && <p className={msg.ok ? 'cm-ok' : 'error-text'} role="status">{msg.text}</p>}
      <div className="ly-form-actions">
        {listing && (
          <ConfirmButton className="btn danger" confirmLabel="Really unlist?" onConfirm={() => act(() => unlistServer(sid, listing), 'Unlisted. The public invite was revoked.')} disabled={busy}>
            Unlist
          </ConfirmButton>
        )}
        {listing && inviteGone ? (
          <button type="button" className="btn primary" disabled={busy || !preview} onClick={() => act(() => publishListing(sid, { ...form, members: memberCount }, { current: listing, newInvite: true }), 'New public invite created')}>
            Create a new invite
          </button>
        ) : (
          <button className="btn primary" disabled={busy || !preview || (!listing && !agree)}>
            {busy ? <span className="spinner ly-spinner-sm" /> : listing ? 'Update listing' : 'List in Discover'}
          </button>
        )}
      </div>
    </form>
  );
}
