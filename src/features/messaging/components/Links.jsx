// Message links: "Copy link" builds them (index.js); LinkRouter (appMounts) opens them from the URL
// hash, from clicks on such links anywhere in the app, and on hash changes; LinkChips (messageExtras)
// shows each link in a message as a compact "Jump to message in #channel" chip.
import { useEffect } from 'react';
import { useChannels, useServerMeta } from '../../../components/layout/hooks.js';
import { useProfile } from '../../../lib/profiles.js';
import { useGroup } from '../../../lib/groups.js';
import { dmPeerOf, findMessageLinks, parseMessageHash, parseMessageLink } from '../lib/links.js';
import { openTarget, setWorkspace } from '../lib/jump.js';

/** appMounts: hash routes (#/m/…) and in-app handling of message links. */
export function LinkRouter({ ctx }) {
  useEffect(() => {
    setWorkspace(ctx);
  }, [ctx]);
  useEffect(() => () => setWorkspace(null), []);

  useEffect(() => {
    const fromHash = () => {
      const t = parseMessageHash(window.location.hash);
      if (!t) return;
      // Drop the route from the address bar (like invite links) so a reload doesn't jump again.
      history.replaceState(null, '', window.location.pathname + window.location.search);
      openTarget(t);
    };
    // Same-tab clicks on links to this app stay in the app (the sanitizer gives links target=_blank).
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : e.target?.parentElement;
      const a = el?.closest?.('a[href]');
      if (!a || a.hasAttribute('download')) return;
      const t = parseMessageLink(a.href);
      if (!t) return;
      e.preventDefault();
      openTarget(t);
    };
    const first = setTimeout(fromHash, 0); // after the workspace ctx is registered
    window.addEventListener('hashchange', fromHash);
    document.addEventListener('click', onClick, true);
    return () => {
      clearTimeout(first);
      window.removeEventListener('hashchange', fromHash);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
  return null;
}

function ChannelLabel({ t, here }) {
  const { channels } = useChannels(t.sid);
  const meta = useServerMeta(t.sid === here ? null : t.sid);
  const ch = channels.find((c) => c.cid === t.cid);
  const name = ch?.name ? `#${ch.name}` : 'a channel';
  return <>{name}{t.sid !== here && meta?.status === 'ready' && meta.name ? <span className="mx-chip-sub"> · {meta.name}</span> : null}</>;
}

function DmLabel({ t, me }) {
  const peer = dmPeerOf(t.dmId, me);
  const p = useProfile(peer);
  if (!peer) return <>a private conversation</>;
  return <>{p?.name ? `@${p.name}` : 'a direct message'}</>;
}

function GroupLabel({ t }) {
  const g = useGroup(t.gid);
  return <>{g?.status === 'ready' && g.name ? g.name : 'a group'}</>;
}

function Chip({ t, ctx }) {
  const label = t.kind === 'channel'
    ? <ChannelLabel t={t} here={ctx.conv?.sid} />
    : t.kind === 'dm'
      ? <DmLabel t={t} me={ctx.me?.uid} />
      : <GroupLabel t={t} />;
  return (
    <button type="button" className="mx-chip" onClick={() => openTarget(t, { toast: (text) => ctx.toast(text) })}>
      <span className="mx-chip-icon" aria-hidden="true">↪</span>
      <span className="mx-chip-text">Jump to message in {label}</span>
    </button>
  );
}

/** messageExtras: chips for the message links in a message's text. */
export function LinkChips({ m, ctx }) {
  const links = findMessageLinks(m?.body?.text);
  if (!links.length) return null;
  return (
    <div className="mx-chips">
      {links.map((t) => <Chip key={`${t.kind}:${t.sid || t.dmId || t.gid}:${t.cid || ''}:${t.mid}`} t={t} ctx={ctx} />)}
    </div>
  );
}
