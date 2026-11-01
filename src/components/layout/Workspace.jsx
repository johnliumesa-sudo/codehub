// The app frame: server rail, channel/DM sidebar, header tabs (Chat | Collab), content, member list.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import ChatView from '../chat/ChatView.jsx';
import SettingsModal from '../settings/SettingsModal.jsx';
import { startPresence } from '../../lib/presence.js';
import { AVATAR_COLORS, useProfile } from '../../lib/profiles.js';
import {
  canManage,
  channelScope,
  clearPlainCache,
  dmScope,
  forgetServer,
  hideDm,
  leaveServer,
  openDm,
  peerFromDmId,
} from '../../lib/servers.js';
import ChannelSidebar from './ChannelSidebar.jsx';
import DmSidebar from './DmSidebar.jsx';
import Header from './Header.jsx';
import MemberList from './MemberList.jsx';
import ServerRail from './ServerRail.jsx';
import ServerSettingsModal from './ServerSettingsModal.jsx';
import UserPanel from './UserPanel.jsx';
import {
  useChannels,
  useDbValue,
  useLastMessages,
  useMediaQuery,
  useMembers,
  useServerMeta,
  useUserDms,
  useUserServers,
} from './hooks.js';
import { ChannelModal, CreateJoinModal, NewDmModal, PendingInviteModal } from './modals.jsx';
import FriendsView from './FriendsView.jsx';
import { useFriends } from '../../lib/friends.js';
import { ConfirmButton, ErrorBoundary, Icon, Modal, ToastProvider, useToast } from './ui.jsx';
import './layout.css';

const CollabView = lazy(() => import('../collab/CollabView.jsx'));

const PENDING_KEY = 'codehub.pendingInvite';
const navKey = (uid) => `codehub.nav.${uid}`;
const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const DEFAULT_NAV = { sid: null, dmId: null, tab: 'chat', chatCid: {}, codeCid: {}, right: { chat: 'members', collab: null } };

function loadNav(uid) {
  try {
    const v = JSON.parse(localStorage.getItem(navKey(uid)) || 'null');
    return v ? { ...DEFAULT_NAV, ...v, right: { ...DEFAULT_NAV.right, ...(v.right || {}) } } : DEFAULT_NAV;
  } catch {
    return DEFAULT_NAV;
  }
}

function readPending() {
  try {
    const v = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    return v && v.sid && v.inviteId && v.key ? v : null;
  } catch {
    return null;
  }
}

function clearPending() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

function EmptyState({ icon = 'message', title, children, action }) {
  return (
    <div className="ly-empty">
      <div className="ly-empty-icon"><Icon name={icon} size={28} /></div>
      <h3>{title}</h3>
      {children && <div className="muted ly-empty-text">{children}</div>}
      {action}
    </div>
  );
}

function Loading() {
  return (
    <div className="ly-empty">
      <div className="spinner" />
    </div>
  );
}

export default function Workspace(props) {
  return (
    <ToastProvider>
      <WorkspaceFrame {...props} />
    </ToastProvider>
  );
}

function WorkspaceFrame({ user }) {
  const uid = user.uid;
  const toast = useToast();
  const profile = useProfile(uid);
  const me = useMemo(
    () => ({
      ...(profile || {}),
      uid,
      name: profile?.name || user.email?.split('@')[0] || 'You',
      color: profile?.color || AVATAR_COLORS[0],
      email: user.email,
    }),
    [profile, uid, user.email],
  );

  // ---------- lifecycle: presence + plaintext cache ----------
  useEffect(() => {
    const stop = startPresence(uid);
    return () => {
      if (typeof stop === 'function') stop();
    };
  }, [uid]);
  useEffect(() => () => clearPlainCache(), []);

  // ---------- navigation state (persisted per user, no secrets) ----------
  const [nav, setNav] = useState(() => loadNav(uid));
  useEffect(() => {
    try {
      localStorage.setItem(navKey(uid), JSON.stringify(nav));
    } catch {
      /* storage full / disabled */
    }
  }, [uid, nav]);

  const mobile = useMediaQuery('(max-width: 760px)');
  const wide = useMediaQuery('(min-width: 1180px)');
  const [navOpen, setNavOpen] = useState(false);
  const [overlayRight, setOverlayRight] = useState(null); // right panel on narrow screens (transient)
  const [modal, setModal] = useState(null);
  const [pending, setPending] = useState(readPending);

  useEffect(() => {
    if (!mobile) setNavOpen(false);
  }, [mobile]);

  // Off-canvas nav on phones: `inert` removes it from the tab order and the a11y tree while closed
  // (React 18 doesn't know the attribute, so set the property). Focus moves in on open and back
  // to the menu button on close.
  const navRef = useRef(null);
  const navWasOpen = useRef(false);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const hidden = mobile && !navOpen;
    el.inert = hidden;
    if (hidden) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
    if (mobile && navOpen && !navWasOpen.current) {
      requestAnimationFrame(() => el.querySelector('button, [href], input, [tabindex]:not([tabindex="-1"])')?.focus());
    } else if (mobile && !navOpen && navWasOpen.current) {
      document.querySelector('.ly-menu-btn, [data-menu-button]')?.focus();
    }
    navWasOpen.current = mobile && navOpen;
  }, [mobile, navOpen]);

  // Invite links opened while already in the app: App.jsx stores them on hashchange (its listener
  // runs after ours, hence the deferral).
  useEffect(() => {
    const on = () => setTimeout(() => setPending(readPending()), 0);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // ---------- data ----------
  const { loading: serversLoading, servers } = useUserServers(uid);
  const { value: readsVal } = useDbValue(`reads/${uid}`);
  const reads = readsVal || {};
  const peerOf = useCallback((dmId) => peerFromDmId(dmId, uid), [uid]);
  const { loading: dmsLoading, dms, error: dmsError } = useUserDms(uid, peerOf);
  const friends = useFriends(uid);
  const friendRequests = friends.list.filter((f) => f.state === 'in').length;

  const sid = nav.sid;
  useEffect(() => {
    if (!serversLoading && sid && !servers.some((s) => s.sid === sid)) setNav((n) => ({ ...n, sid: null }));
  }, [serversLoading, servers, sid]);

  // Re-subscribe key: changes when I (re)join this server, or after a stale-icon re-check found
  // access again — RTDB never revives a listener it cancelled with permission_denied.
  const [refreshTick, setRefreshTick] = useState(0);
  const joinedAt = sid ? servers.find((s) => s.sid === sid)?.joinedAt || 0 : 0;
  const nonce = `${joinedAt}|${refreshTick}`;
  const meta = useServerMeta(sid, nonce);
  const { loading: chLoading, channels, error: chError } = useChannels(sid, nonce);
  const { loading: memLoading, members } = useMembers(sid, nonce);
  const myRole = members.find((m) => m.uid === uid)?.role || 'member';
  const channelIds = useMemo(() => channels.map((c) => c.cid), [channels]);
  const lastMsgs = useLastMessages(sid ? `messages/${sid}` : null, channelIds, nonce);

  const tab = sid && nav.tab === 'collab' ? 'collab' : 'chat';
  const textChannels = channels.filter((c) => c.type === 'text');
  const codeChannels = channels.filter((c) => c.type === 'code');
  const pool = tab === 'chat' ? textChannels : codeChannels;
  const wantCid = sid ? (tab === 'chat' ? nav.chatCid[sid] : nav.codeCid[sid]) : null;
  const channel = pool.find((c) => c.cid === wantCid) || pool[0] || null;

  // DM
  const dmId = !sid ? nav.dmId : null;
  const dmPeerUid = dmId ? peerFromDmId(dmId, uid) : null;
  const dmPeer = useProfile(dmPeerUid);

  // Unread on the home button (any DM newer than its read marker, excluding the open one).
  const homeUnread = friendRequests > 0 || dms.some((d) => (sid || d.dmId !== dmId) && d.lastTs > (reads[dmScope(d.dmId)] || 0));

  // ---------- right panel ----------
  const rightOptions = sid ? (tab === 'collab' ? ['chat', 'members'] : ['members']) : [];
  const storedRight = nav.right[tab];
  const rightPanel = !sid ? null : wide ? storedRight : overlayRight;
  const setRightPanel = (p) => {
    if (wide) setNav((n) => ({ ...n, right: { ...n.right, [tab]: p } }));
    else setOverlayRight(p);
  };
  useEffect(() => setOverlayRight(null), [sid, tab, wide]);

  // ---------- navigation actions ----------
  const goHome = () => {
    setNav((n) => ({ ...n, sid: null }));
  };
  const goServer = (s) => setNav((n) => ({ ...n, sid: s }));
  const selectChannel = (ch) => {
    setNav((n) =>
      ch.type === 'code'
        ? { ...n, tab: 'collab', codeCid: { ...n.codeCid, [sid]: ch.cid } }
        : { ...n, tab: 'chat', chatCid: { ...n.chatCid, [sid]: ch.cid } },
    );
    if (mobile) setNavOpen(false);
  };
  const selectDm = (d) => {
    setNav((n) => ({ ...n, sid: null, dmId: d.dmId }));
    if (mobile) setNavOpen(false);
  };
  const setTab = (t) => setNav((n) => ({ ...n, tab: t }));

  const messageUser = async (peerUid) => {
    try {
      const id = await openDm(uid, peerUid);
      setModal(null);
      setNav((n) => ({ ...n, sid: null, dmId: id }));
      if (mobile) setNavOpen(false);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const enterServer = (s, cid, type = 'text') => {
    setNav((n) => ({
      ...n,
      sid: s,
      tab: type === 'code' ? 'collab' : 'chat',
      ...(cid ? (type === 'code' ? { codeCid: { ...n.codeCid, [s]: cid } } : { chatCid: { ...n.chatCid, [s]: cid } }) : {}),
    }));
    if (mobile) setNavOpen(false);
  };

  const onStale = async (s) => {
    // Re-check first: I may have been re-invited since the listener was revoked.
    try {
      if ((await get(ref(db, `servers/${s}/meta`))).exists()) {
        setRefreshTick((t) => t + 1);
        toast('You have access to this server again', 'success');
        return;
      }
    } catch {
      /* denied -> really gone */
    }
    try {
      await forgetServer(s, uid);
      toast('Removed a server you no longer have access to', 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  // ---------- document title ----------
  useEffect(() => {
    const t = sid ? (channel?.name ? `${tab === 'chat' ? '#' : ''}${channel.name} · ${meta.name || ''}` : meta.name) : dmPeer?.name;
    document.title = t ? `${t} — Codehub` : 'Codehub';
  }, [sid, tab, channel?.name, meta.name, dmPeer?.name]);

  useEffect(() => () => {
    document.title = 'Codehub';
  }, []);

  // ---------- content ----------
  const chatConv = useMemo(() => {
    if (!sid && dmId && dmPeerUid) {
      return { kind: 'dm', dmId, peerUid: dmPeerUid, title: dmPeer?.name || 'Direct message', scope: dmScope(dmId) };
    }
    if (sid && channel && !channel.pending && !channel.failed) {
      return { kind: 'channel', sid, cid: channel.cid, title: channel.name, scope: channelScope(sid, channel.cid) };
    }
    return null;
  }, [sid, dmId, dmPeerUid, dmPeer?.name, channel?.cid, channel?.name, channel?.pending, channel?.failed]); // eslint-disable-line react-hooks/exhaustive-deps

  const admin = canManage(myRole);
  const nextPosition = channels.reduce((m, c) => Math.max(m, c.position), 0) + 1;

  let content;
  if (!sid) {
    content = chatConv ? (
      <ChatView key={chatConv.scope} conv={chatConv} me={me} />
    ) : (
      <FriendsView me={me} friends={friends} onMessage={messageUser} />
    );
  } else if (meta.status === 'loading' || chLoading) {
    content = <Loading />;
  } else if (meta.status !== 'ready') {
    content = <EmptyState icon="x" title="This server isn't available">You may have been removed, or it was deleted.</EmptyState>;
  } else if (meta.nameFailed) {
    content = (
      <EmptyState icon="lock" title="Can't decrypt this server">
        Your copy of the server key is missing or invalid. Ask an admin for a fresh invite link.
      </EmptyState>
    );
  } else if (chError) {
    content = <EmptyState icon="x" title="Couldn't load channels">{errMsg(chError)}</EmptyState>;
  } else if (!channel) {
    const isCode = tab === 'collab';
    content = (
      <EmptyState
        icon={isCode ? 'code' : 'hash'}
        title={isCode ? 'No code workspaces yet' : 'No text channels yet'}
        action={
          admin && (
            <button className="btn primary" onClick={() => setModal({ type: 'channel', initialType: isCode ? 'code' : 'text' })}>
              <Icon name="plus" size={15} /> {isCode ? 'Create workspace' : 'Create channel'}
            </button>
          )
        }
      >
        {isCode
          ? 'Workspaces are shared, encrypted code editors with GitHub integration.'
          : admin
            ? 'Create one to start talking.'
            : 'Ask an admin to create one.'}
      </EmptyState>
    );
  } else if (channel.pending) {
    content = <Loading />;
  } else if (channel.failed) {
    content = <EmptyState icon="lock" title="Can't decrypt this channel">Its name could not be decrypted with your server key.</EmptyState>;
  } else if (tab === 'chat') {
    content = <ChatView key={`${chatConv.scope}|${nonce}`} conv={chatConv} me={me} />;
  } else {
    content = (
      <Suspense fallback={<Loading />}>
        <CollabView key={`${sid}/${channel.cid}|${nonce}`} sid={sid} cid={channel.cid} me={me} serverName={meta.name || ''} />
      </Suspense>
    );
  }

  const rightContent =
    rightPanel === 'members' ? (
      <MemberList members={members} loading={memLoading} myUid={uid} onMessage={messageUser} />
    ) : rightPanel === 'chat' && chatConv && tab === 'collab' ? (
      <ErrorBoundary resetKey={chatConv.scope}>
        <ChatView key={`side-${chatConv.scope}|${nonce}`} conv={chatConv} me={me} />
      </ErrorBoundary>
    ) : null;

  const rightTitle = rightPanel === 'members' ? `Members — ${members.length}` : `# ${channel?.name || ''}`;

  const right = rightContent && (
    <aside className={`ly-right ${rightPanel} ${wide ? 'inline' : 'overlay'}`}>
      <div className="ly-right-head">
        <span>{rightTitle}</span>
        <button className="btn ghost sm ly-icon-btn" onClick={() => setRightPanel(null)} aria-label="Close panel">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="ly-right-body">{rightContent}</div>
    </aside>
  );

  return (
    <div className={`ly-app ${mobile ? 'mobile' : ''} ${navOpen ? 'nav-open' : ''}`}>
      <div className="ly-nav" ref={navRef}>
        <ServerRail
          servers={servers}
          loading={serversLoading}
          activeSid={sid}
          homeUnread={homeUnread}
          onHome={goHome}
          onSelect={goServer}
          onStale={onStale}
          onCreateJoin={() => setModal({ type: 'createJoin' })}
          reads={reads}
          myUid={uid}
          refreshTick={refreshTick}
        />
        <div className="ly-sidebar">
          {sid ? (
            <ChannelSidebar
              sid={sid}
              meta={meta}
              myRole={myRole}
              channels={channels}
              loading={chLoading || meta.status === 'loading'}
              error={chError}
              tab={tab}
              activeCid={channel?.cid}
              reads={reads}
              lastMsgs={lastMsgs}
              myUid={uid}
              onSelect={selectChannel}
              onCreateChannel={(t) => setModal({ type: 'channel', initialType: t })}
              onEditChannel={(ch) => setModal({ type: 'channel', channel: ch })}
              onOpenSettings={() => setModal({ type: 'server', tab: 'overview' })}
              onInvite={() => setModal({ type: 'server', tab: 'invites' })}
              onLeave={() => setModal({ type: 'leave' })}
            />
          ) : (
            <DmSidebar
              dms={dms}
              loading={dmsLoading}
              error={dmsError}
              activeDmId={dmId}
              reads={reads}
              myUid={uid}
              onSelect={selectDm}
              onNewDm={() => setModal({ type: 'newDm' })}
              onFriends={() => {
                setNav((n) => ({ ...n, dmId: null }));
                if (mobile) setNavOpen(false);
              }}
              friendRequests={friendRequests}
              onHide={async (d) => {
                try {
                  await hideDm(uid, d.dmId);
                  if (d.dmId === nav.dmId) setNav((n) => ({ ...n, dmId: null }));
                } catch (e) {
                  toast(errMsg(e), 'error');
                }
              }}
            />
          )}
          <UserPanel me={me} onSettings={() => setModal({ type: 'settings' })} />
        </div>
      </div>
      {mobile && navOpen && <div className="ly-scrim" onClick={() => setNavOpen(false)} />}

      <main className="ly-main">
        <Header
          mode={sid ? 'server' : 'home'}
          tab={tab}
          onTab={setTab}
          channel={channel}
          peer={dmPeerUid ? dmPeer || { uid: dmPeerUid } : null}
          serverName={meta.name}
          rightPanel={rightPanel}
          rightOptions={rightOptions}
          onRightPanel={setRightPanel}
          onMenu={() => setNavOpen(true)}
          showMenuButton={mobile}
        />
        <div className="ly-body">
          <div className={`ly-content ${tab}`}>
            <ErrorBoundary resetKey={`${sid}|${tab}|${channel?.cid}|${dmId}`}>{content}</ErrorBoundary>
          </div>
          {wide && right}
        </div>
      </main>
      {!wide && right && (
        <>
          <div className="ly-scrim right" onClick={() => setRightPanel(null)} />
          {right}
        </>
      )}

      {/* ---------- modals ---------- */}
      {modal?.type === 'settings' && <SettingsModal user={user} me={me} onClose={() => setModal(null)} />}
      {modal?.type === 'createJoin' && (
        <CreateJoinModal
          me={me}
          onClose={() => setModal(null)}
          onCreated={({ sid: s, generalCid }) => {
            setModal(null);
            enterServer(s, generalCid);
            toast('Server created — invite people from the server menu', 'success');
          }}
          onJoined={({ sid: s, alreadyMember }) => {
            setModal(null);
            enterServer(s);
            toast(alreadyMember ? "You're already a member" : 'Joined server', 'success');
          }}
        />
      )}
      {modal?.type === 'newDm' && (
        <NewDmModal
          me={me}
          serverIds={servers.map((s) => s.sid)}
          onClose={() => setModal(null)}
          onOpen={(id) => {
            setModal(null);
            setNav((n) => ({ ...n, sid: null, dmId: id }));
            if (mobile) setNavOpen(false);
          }}
        />
      )}
      {modal?.type === 'channel' && sid && (
        <ChannelModal
          sid={sid}
          channel={modal.channel}
          initialType={modal.initialType}
          nextPosition={nextPosition}
          onClose={() => setModal(null)}
          onCreated={({ cid, type }) => {
            setModal(null);
            enterServer(sid, cid, type);
          }}
          onDeleted={() => setModal(null)}
        />
      )}
      {modal?.type === 'server' && sid && meta.status === 'ready' && (
        <ServerSettingsModal
          sid={sid}
          meta={meta}
          myRole={myRole}
          me={me}
          members={members}
          initialTab={modal.tab}
          onClose={() => setModal(null)}
          onLeft={() => {
            setModal(null);
            setNav((n) => ({ ...n, sid: null }));
          }}
          onMessage={messageUser}
        />
      )}
      {modal?.type === 'leave' && sid && (
        <Modal title={`Leave ${meta.name || 'server'}?`} onClose={() => setModal(null)}>
          <p className="muted">You won't be able to rejoin unless someone sends you a new invite.</p>
          <div className="ly-form-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <ConfirmButton
              className="btn danger"
              confirmLabel="Really leave?"
              onConfirm={async () => {
                try {
                  await leaveServer(sid, uid);
                  setModal(null);
                  setNav((n) => ({ ...n, sid: null }));
                  toast('Left server', 'success');
                } catch (e) {
                  toast(errMsg(e), 'error');
                }
              }}
            >
              Leave server
            </ConfirmButton>
          </div>
        </Modal>
      )}
      {pending && !modal && (
        <PendingInviteModal
          me={me}
          invite={pending}
          onDismiss={() => {
            clearPending();
            setPending(null);
          }}
          onDone={({ sid: s, alreadyMember }) => {
            clearPending();
            setPending(null);
            enterServer(s);
            toast(alreadyMember ? "You're already a member of that server" : 'Joined server', 'success');
          }}
        />
      )}
    </div>
  );
}
