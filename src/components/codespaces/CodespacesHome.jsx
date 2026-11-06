// Codespaces home: my codespaces on the left, the open codespace (full CollabView) on the right.
// Props: { me, activeCsid, onOpen(csid|null), footer?: ReactNode (e.g. <UserPanel/>),
//          showMenuButton?: boolean, onMenu?: () => void,
//          createSignal?: number  (increment to open the "New codespace" modal, e.g. from the command palette) }
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useProfiles } from '../../lib/profiles.js';
import { ROLE_LABEL, forgetCodespace, useCodespace, useMyCodespaces } from '../../lib/codespaces.js';
import { codespaceSpace, spaceStorageKey } from '../../lib/collab/space.js';
import { TEMPLATES } from '../../lib/codespaceTemplates.js';
import { useMediaQuery } from '../layout/hooks.js';
import { Avatar, ErrorBoundary, Icon, useToast } from '../layout/ui.jsx';
import CreateCodespaceModal from './CreateCodespaceModal.jsx';
import CodespaceMembersModal from './CodespaceMembersModal.jsx';
import './codespaces.css';

const CollabView = lazy(() => import('../collab/CollabView.jsx'));

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

function rememberActiveFile(csid, fid) {
  if (!fid) return;
  try {
    localStorage.setItem(spaceStorageKey(codespaceSpace(csid)), fid);
  } catch {
    /* storage disabled */
  }
}

function Loading() {
  return (
    <div className="cs-empty">
      <div className="spinner" />
    </div>
  );
}

function CodespaceIcon({ name, size = 30 }) {
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="cs-icon" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden="true">
      {letter}
    </span>
  );
}

function ListItem({ cs, active, onOpen }) {
  const label = cs.status === 'missing' ? 'Unavailable codespace' : cs.nameFailed ? 'Locked codespace' : cs.name || '…';
  return (
    <button
      className={`cs-item ${active ? 'active' : ''} ${cs.status === 'missing' ? 'stale' : ''}`}
      onClick={() => onOpen(cs.csid)}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      {cs.status === 'missing' ? (
        <span className="cs-icon stale" aria-hidden="true"><Icon name="x" size={14} /></span>
      ) : cs.nameFailed ? (
        <span className="cs-icon" aria-hidden="true"><Icon name="lock" size={14} /></span>
      ) : (
        <CodespaceIcon name={cs.name} />
      )}
      <span className="cs-item-text">
        <span className="cs-item-name">{cs.status === 'loading' && !cs.name ? <span className="cs-skeleton" /> : label}</span>
        {cs.role && <span className="cs-item-role">{ROLE_LABEL[cs.role] || cs.role}</span>}
      </span>
    </button>
  );
}

function MemberFaces({ members, max = 4 }) {
  const uids = useMemo(() => members.map((m) => m.uid), [members]);
  const profiles = useProfiles(uids);
  const shown = uids.slice(0, max);
  return (
    <span className="cs-faces">
      {shown.map((u) => (
        <Avatar key={u} profile={profiles[u] || { name: '?' }} size={24} ring="var(--bg-2)" />
      ))}
      {uids.length > max && <span className="cs-faces-more">+{uids.length - max}</span>}
    </span>
  );
}

function CodespacePane({ csid, me, mobile, onBack, onClosed, initialModal, onModalShown }) {
  const toast = useToast();
  const cs = useCodespace(csid, me.uid);
  const [modal, setModal] = useState(initialModal || null); // null | 'members' | 'settings'
  useEffect(() => {
    if (initialModal) onModalShown?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const space = useMemo(() => codespaceSpace(csid), [csid]);

  if (cs.status === 'loading') return <Loading />;
  if (cs.status === 'missing') {
    return (
      <div className="cs-empty">
        <div className="cs-empty-icon danger"><Icon name="x" size={26} /></div>
        <h3>This codespace isn’t available</h3>
        <p className="muted">It was deleted, or the owner removed you.</p>
        <button
          className="btn"
          onClick={async () => {
            try {
              await forgetCodespace(csid, me.uid);
            } catch (e) {
              toast(errMsg(e), 'error');
            }
            onClosed();
          }}
        >
          Remove from list
        </button>
      </div>
    );
  }

  const name = cs.meta.nameFailed ? 'Locked codespace' : cs.meta.name || 'Codespace';
  const readOnly = cs.myRole === 'viewer';

  return (
    <div className="cs-pane">
      <header className="cs-bar">
        {mobile && (
          <button className="btn ghost sm cs-icon-btn" onClick={onBack} aria-label="Back to codespaces">
            <Icon name="back" size={18} />
          </button>
        )}
        <CodespaceIcon name={cs.meta.name} size={26} />
        <h2 className="cs-bar-title" title={name}>{name}</h2>
        {cs.myRole && <span className={`cs-role-badge ${cs.myRole}`}>{ROLE_LABEL[cs.myRole]}</span>}
        {readOnly && <span className="cs-readonly" title="You can read and follow along, but not edit">Read-only</span>}
        <span className="cs-bar-spacer" />
        <button className="cs-faces-btn" onClick={() => setModal('members')} title="Members" aria-label={`Members (${cs.members.length})`}>
          <MemberFaces members={cs.members} />
        </button>
        <button className="btn sm" onClick={() => setModal('members')}>
          <Icon name={cs.isOwner ? 'userPlus' : 'users'} size={15} />
          <span className="cs-hide-narrow">{cs.isOwner ? 'Share' : 'Members'}</span>
        </button>
        <button className="btn ghost sm cs-icon-btn" onClick={() => setModal('settings')} aria-label="Codespace settings" title="Settings">
          <Icon name="gear" size={16} />
        </button>
      </header>
      <div className="cs-body">
        <ErrorBoundary resetKey={csid}>
          <Suspense fallback={<Loading />}>
            <CollabView key={csid} space={space} title={name} serverName={name} readOnly={readOnly} me={me} />
          </Suspense>
        </ErrorBoundary>
      </div>
      {modal && (
        <CodespaceMembersModal
          csid={csid}
          cs={cs}
          me={me}
          initialTab={modal}
          onClose={() => setModal(null)}
          onLeft={() => {
            setModal(null);
            onClosed();
          }}
          onDeleted={() => {
            setModal(null);
            onClosed();
          }}
        />
      )}
    </div>
  );
}

function Welcome({ count, onCreate }) {
  return (
    <div className="cs-empty cs-welcome">
      <div className="cs-empty-icon"><Icon name="code" size={28} /></div>
      <h3>{count ? 'Pick a codespace' : 'Your encrypted codespaces'}</h3>
      <p className="muted">
        Codespaces are collaborative code workspaces that don’t belong to any server. Invite exactly who you want as an editor or
        viewer. Everything you write is end-to-end encrypted.
      </p>
      <div className="cs-quick">
        {TEMPLATES.filter((t) => t.id !== 'blank').map((t) => (
          <button key={t.id} className="cs-quick-card" onClick={() => onCreate(t.id)}>
            <span className="cs-template-icon" aria-hidden="true">{t.icon}</span>
            <span>{t.name}</span>
          </button>
        ))}
      </div>
      <button className="btn primary" onClick={() => onCreate('blank')}>
        <Icon name="plus" size={15} /> New codespace
      </button>
    </div>
  );
}

export default function CodespacesHome({ me, activeCsid, onOpen, footer, showMenuButton = false, onMenu, createSignal = 0 }) {
  const toast = useToast();
  const { loading, codespaces } = useMyCodespaces(me.uid);
  const mobile = useMediaQuery('(max-width: 760px)');
  const [createWith, setCreateWith] = useState(null); // template id while the create modal is open
  const [pendingModal, setPendingModal] = useState(null); // { csid, tab } to open after creating
  const [justCreated, setJustCreated] = useState(null); // csid whose index entry may not have arrived yet

  useEffect(() => {
    if (createSignal) setCreateWith('blank');
  }, [createSignal]);

  // The open codespace vanished from my index (deleted, removed, left elsewhere): close it.
  const known = codespaces.some((c) => c.csid === activeCsid);
  useEffect(() => {
    if (known && justCreated === activeCsid) setJustCreated(null);
    if (!loading && activeCsid && !known && justCreated !== activeCsid) onOpen(null);
  }, [loading, activeCsid, known, justCreated]); // eslint-disable-line react-hooks/exhaustive-deps

  const showList = !mobile || !activeCsid;
  const showMain = !mobile || !!activeCsid;

  return (
    <div className={`cs-home ${mobile ? 'mobile' : ''}`}>
      {showList && (
        <aside className="cs-list" aria-label="Codespaces">
          <div className="cs-list-head">
            {showMenuButton && (
              <button className="btn ghost sm cs-icon-btn" onClick={onMenu} aria-label="Open navigation" data-menu-button>
                <Icon name="menu" size={18} />
              </button>
            )}
            <h2>Codespaces</h2>
            <button className="btn ghost sm cs-icon-btn" onClick={() => setCreateWith('blank')} aria-label="New codespace" title="New codespace">
              <Icon name="plus" size={18} />
            </button>
          </div>
          <div className="cs-list-body">
            {loading ? (
              [0, 1, 2].map((i) => (
                <div key={i} className="cs-item ghost">
                  <span className="cs-icon" />
                  <span className="cs-skeleton" />
                </div>
              ))
            ) : codespaces.length === 0 ? (
              <div className="cs-list-empty muted">
                No codespaces yet.
                <button className="btn sm primary" onClick={() => setCreateWith('blank')}>
                  <Icon name="plus" size={13} /> Create one
                </button>
              </div>
            ) : (
              codespaces.map((c) => <ListItem key={c.csid} cs={c} active={c.csid === activeCsid} onOpen={onOpen} />)
            )}
          </div>
          {footer && <div className="cs-list-foot">{footer}</div>}
        </aside>
      )}
      {showMain && (
        <section className="cs-main">
          {activeCsid ? (
            <CodespacePane
              key={activeCsid}
              csid={activeCsid}
              me={me}
              mobile={mobile}
              onBack={() => onOpen(null)}
              onClosed={() => onOpen(null)}
              initialModal={pendingModal?.csid === activeCsid ? pendingModal.tab : null}
              onModalShown={() => setPendingModal(null)}
            />
          ) : (
            <Welcome count={codespaces.length} onCreate={(tid) => setCreateWith(tid)} />
          )}
        </section>
      )}
      {createWith && (
        <CreateCodespaceModal
          me={me}
          initialTemplate={createWith}
          onClose={() => setCreateWith(null)}
          onCreated={({ csid, openFid, share, failed }) => {
            setCreateWith(null);
            rememberActiveFile(csid, openFid);
            setJustCreated(csid);
            if (share) setPendingModal({ csid, tab: 'members' });
            onOpen(csid);
            if (failed.length) toast(`Created, but ${failed.length} starter file${failed.length === 1 ? '' : 's'} couldn’t be added`, 'error');
            else toast('Codespace created', 'success');
          }}
        />
      )}
    </div>
  );
}
