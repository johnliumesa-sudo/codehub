// sidebarSections: "Drafts" at the top of the channel sidebar (this server's channels) and of the DM
// sidebar (direct messages and groups), each with a pencil marker. Clicking opens the conversation,
// where the composer restores the text.
import { useProfile } from '../../../lib/profiles.js';
import { useDraftList, useDraftTitle } from '../lib/drafts.js';
import { dmPeerOf } from '../lib/links.js';

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function DraftRow({ d, uid, label, onOpen }) {
  const stored = useDraftTitle(uid, d.conv, d.at);
  const text = label || stored || (d.conv.kind === 'channel' ? 'a channel' : d.conv.kind === 'dm' ? 'a direct message' : 'a group');
  return (
    <li>
      <button type="button" className="mx-draft-row" onClick={onOpen} aria-label={`Draft in ${text}`} title={`Unsent draft in ${text}`}>
        <span className="mx-draft-pencil"><PencilIcon /></span>
        <span className="mx-draft-name">{text}</span>
      </button>
    </li>
  );
}

function DmDraftRow({ d, uid, onOpen }) {
  const peer = dmPeerOf(d.conv.dmId, uid);
  const p = useProfile(peer);
  return <DraftRow d={d} uid={uid} label={p?.name ? `@${p.name}` : ''} onOpen={onOpen} />;
}

function DraftsSection({ ctx }) {
  const uid = ctx?.me?.uid;
  const all = useDraftList(uid);
  if (!uid) return null;
  let list;
  if (ctx.view === 'server') {
    const active = ctx.server?.tab === 'chat' ? ctx.server?.activeCid : null;
    list = all.filter((d) => d.conv.kind === 'channel' && d.conv.sid === ctx.sid && d.conv.cid !== active);
  } else {
    list = all.filter((d) => (d.conv.kind === 'dm' && d.conv.dmId !== ctx.nav?.dmId) || (d.conv.kind === 'group' && d.conv.gid !== ctx.nav?.gid));
  }
  if (!list.length) return null;
  const names = new Map((ctx.server?.channels || []).map((c) => [c.cid, c.name]));
  return (
    <section className="mx-drafts" aria-label="Drafts">
      <h3 className="mx-drafts-h">Drafts <span className="mx-drafts-count">{list.length}</span></h3>
      <ul className="mx-drafts-list">
        {list.slice(0, 8).map((d) => {
          const open = () => ctx.openConv?.(d.conv);
          if (d.conv.kind === 'dm') return <DmDraftRow key={d.key} d={d} uid={uid} onOpen={open} />;
          const name = d.conv.kind === 'channel' && names.get(d.conv.cid) ? `#${names.get(d.conv.cid)}` : '';
          return <DraftRow key={d.key} d={d} uid={uid} label={name} onOpen={open} />;
        })}
      </ul>
    </section>
  );
}

export function draftsSection(ctx) {
  return <DraftsSection ctx={ctx} />;
}
