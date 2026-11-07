// The app frame: server rail, channel/DM/group sidebar, header tabs (Chat | Collab), content, member list,
// plus the top-level views (Codespaces, Arcade, Add-on shop) selected by nav.view.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import ChatView from '../chat/ChatView.jsx';
import SettingsModal from '../settings/SettingsModal.jsx';
import { startPresence } from '../../lib/presence.js';
import { AVATAR_COLORS, useProfile, useProfiles } from '../../lib/profiles.js';
import { themePaletteActions } from '../../lib/theme.js';
import { setTitlePage } from '../../lib/title.js';
import {
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
import BookmarksPanel from '../chatx/BookmarksPanel.jsx';
import { ShortcutsOverlay } from '../serverx/ShortcutsOverlay.jsx';
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
// Groups (F1)
import { groupConv, groupScope, isGroupUnread, useGroup, useGroupMembers, useMyGroups } from '../../lib/groups.js';
import CreateGroupModal from '../groups/CreateGroupModal.jsx';
import GroupSettingsModal from '../groups/GroupSettingsModal.jsx';
import GroupMembersPanel from '../groups/GroupMembersPanel.jsx';
// Codespaces (F2)
import { useMyCodespaces } from '../../lib/codespaces.js';
// Shop (F3)
import AddonRuntime from '../shop/AddonRuntime.jsx';
import ShopView from '../shop/ShopView.jsx'; // static: AddonsTab/CatalogEditor import it anyway
// Roles / moderation (F5, F14)
import { memberOf, permsFor, useServerRoles } from '../../lib/roles.js';
import { useTimeouts } from '../../lib/moderation.js';
// App admin, announcements (F6, F16)
import AdminPanel from '../admin/AdminPanel.jsx';
import AnnouncementBanner from '../admin/AnnouncementBanner.jsx';
// Safety + notifications (F11, F13, F19)
import LinkGuardHost from '../safety/LinkGuardHost.jsx';
import Notifier from '../safety/Notifier.jsx';
import { isMuted, useNotifPrefs, useNotifySources } from '../../lib/notify.js';
import { useBlocks } from '../../lib/blocks.js';
// Productivity (F18, F20)
import CommandPalette from '../productivity/CommandPalette.jsx';
import SnippetLibraryModal from '../productivity/SnippetLibraryModal.jsx';
import { TOGGLE_PREVIEW_EVENT, useHotkey } from '../../lib/palette.js';
import './layout.css';
import IncomingCallModal from '../calls/IncomingCallModal.jsx';
import CallView, { CallAudio } from '../calls/CallView.jsx';
import MiniCallBar from '../calls/MiniCallBar.jsx';
import CallButton from '../calls/CallButton.jsx';
import { parseScope, voiceScope } from '../../lib/calls/core.js';
import { joinCall, useActiveCall } from '../../lib/calls/useCall.js';
import NotificationBell from '../notifications/NotificationBell.jsx';
import { targetOfNotif } from '../../lib/notifications.js';
// Round 3 extension points
import { WorkspaceContext } from '../../lib/ext/workspaceContext.js';
import { get as getExt, useRegistry } from '../../lib/ext/registry.js';
import { AppMounts } from '../ext/WorkspaceExt.jsx';
import { passes, runSafe } from '../ext/ExtRender.jsx';

const CollabView = lazy(() => import('../collab/CollabView.jsx'));
const CodespacesHome = lazy(() => import('../codespaces/CodespacesHome.jsx'));
const GamesView = lazy(() => import('../games/GamesView.jsx'));

const PENDING_KEY = 'codehub.pendingInvite';
const navKey = (uid) => `codehub.nav.${uid}`;
const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const DEFAULT_NAV = {
  sid: null,
  dmId: null,
  gid: null,
  tab: 'chat',
  chatCid: {},
  codeCid: {},
  right: { chat: 'members', collab: null, group: 'members' },
  view: null, // null | 'codespaces' | 'arcade' | 'shop'
  csid: null,
};
const VIEWS = ['codespaces', 'arcade', 'shop'];

function loadNav(uid) {
  try {
    const v = JSON.parse(localStorage.getItem(navKey(uid)) || 'null');
    if (!v) return DEFAULT_NAV;
    return { ...DEFAULT_NAV, ...v, view: VIEWS.includes(v.view) ? v.view : null, right: { ...DEFAULT_NAV.right, ...(v.right || {}) } };
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
  const [pendingGameId, setPendingGameId] = useState(null); // game to open in the Arcade (admin panel)
  const [csCreate, setCsCreate] = useState(0); // bump -> CodespacesHome opens "New codespace"
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const activeCall = useActiveCall();
  // Ctrl/Cmd+K and Ctrl/Cmd+Shift+P toggle the quick switcher (ignored while another modal is open).
  useHotkey(() => setPaletteOpen((o) => !o));

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
  const { groups, loading: groupsLoading } = useMyGroups(uid);
  const { codespaces } = useMyCodespaces(uid);
  const notifPrefs = useNotifPrefs(uid);
  const blocked = useBlocks(uid);
  const groupConvs = useMemo(() => groups.map(groupConv).filter(Boolean), [groups]);
  const notifySources = useNotifySources({ servers, dms, groups: groupConvs });
  // Blocking removes my userDms entry, but the peer could have re-created it before the block.
  const visibleDms = useMemo(() => dms.filter((d) => !blocked.has(d.peer)), [dms, blocked]);
  const dmPeerProfiles = useProfiles(useMemo(() => visibleDms.map((d) => d.peer), [visibleDms]));
  // Where a message can be forwarded: text channels of my servers, my (unblocked) DMs and my groups.
  const forwardTargets = useMemo(() => {
    const dmIds = new Set(visibleDms.map((d) => d.dmId));
    return notifySources
      .filter((s) => (s.conv.kind === 'channel' ? s.type === 'text' : s.conv.kind !== 'dm' || dmIds.has(s.conv.dmId)))
      .map((s) => {
        if (s.conv.kind === 'channel') return { ...s.conv, title: `${s.title || 'channel'}${s.serverName ? ` · ${s.serverName}` : ''}` };
        if (s.conv.kind === 'dm') return { ...s.conv, title: dmPeerProfiles[s.conv.peerUid]?.name || 'Direct message' };
        return { ...s.conv, title: s.title || 'Group' };
      })
      .sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'dm' ? -1 : b.kind === 'dm' ? 1 : a.kind.localeCompare(b.kind)));
  }, [notifySources, visibleDms, dmPeerProfiles]);

  // Top-level views (rail buttons): servers/DMs/groups keep their remembered selection but aren't shown.
  const view = VIEWS.includes(nav.view) ? nav.view : null;
  const csMode = view === 'codespaces';
  const arcade = view === 'arcade';
  const shopMode = view === 'shop';
  const sid = view ? null : nav.sid;
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
  // While the member list loads, the owner is still known from meta (avoids hiding owner controls).
  const myRole = members.find((m) => m.uid === uid)?.role || (meta.ownerId && meta.ownerId === uid ? 'owner' : 'member');
  const meMember = memberOf(members, uid) || { uid, role: myRole };
  const { roles } = useServerRoles(sid, nonce);
  const { timeouts } = useTimeouts(sid, nonce);
  // { staff, manageChannels, manageInvites, kick, ban, manageMessages, manageRoles, timeout, viewAudit }
  const perms = useMemo(() => permsFor(meMember, roles), [meMember.role, meMember.roleId, roles]); // eslint-disable-line react-hooks/exhaustive-deps
  const channelIds = useMemo(() => channels.map((c) => c.cid), [channels]);
  const lastMsgs = useLastMessages(sid ? `messages/${sid}` : null, channelIds, nonce);

  const tab = sid && nav.tab === 'collab' ? 'collab' : 'chat';
  const textChannels = channels.filter((c) => c.type === 'text');
  const codeChannels = channels.filter((c) => c.type === 'code');
  const pool = tab === 'chat' ? textChannels : codeChannels;
  const wantCid = sid ? (tab === 'chat' ? nav.chatCid[sid] : nav.codeCid[sid]) : null;
  const channel = pool.find((c) => c.cid === wantCid) || pool[0] || null;

  // Group / DM (home)
  const gid = !sid && !view ? nav.gid || null : null;
  const dmId = !sid && !view && !gid ? nav.dmId : null;
  const dmPeerUid = dmId ? peerFromDmId(dmId, uid) : null;
  const dmPeer = useProfile(dmPeerUid);
  const group = useGroup(gid);
  const { members: groupMembers, loading: groupMembersLoading } = useGroupMembers(gid);
  useEffect(() => {
    // Removed from the group or it was deleted: fall back to Friends.
    if (gid && (group.status === 'denied' || group.status === 'missing')) setNav((n) => ({ ...n, gid: null }));
  }, [gid, group.status]);

  // Unread on the home button: DMs and groups newer than their read marker (not the open one, not muted).
  const homeUnread =
    friendRequests > 0 ||
    visibleDms.some(
      (d) => (sid || view || d.dmId !== dmId) && d.lastTs > (reads[dmScope(d.dmId)] || 0) && !isMuted(notifPrefs, dmScope(d.dmId)),
    ) ||
    groups.some((g) => (sid || view || g.gid !== gid) && isGroupUnread(g, reads, uid) && !isMuted(notifPrefs, groupScope(g.gid)));

  // ---------- right panel ----------
  const rightKey = sid ? tab : 'group';
  const rightOptions = view ? [] : sid ? (tab === 'collab' ? ['chat', 'members'] : ['members']) : gid ? ['members'] : [];
  const storedRight = nav.right[rightKey];
  const rightPanel = view || (!sid && !gid) ? null : wide ? storedRight : overlayRight;
  const setRightPanel = (p) => {
    if (wide) setNav((n) => ({ ...n, right: { ...n.right, [rightKey]: p } }));
    else setOverlayRight(p);
  };
  useEffect(() => setOverlayRight(null), [sid, tab, wide, gid, view]);

  // ---------- navigation actions ----------
  const goHome = () => {
    setNav((n) => ({ ...n, sid: null, view: null }));
  };
  const goServer = (s) => setNav((n) => ({ ...n, sid: s, view: null }));
  const goCodespaces = () => {
    setNav((n) => ({ ...n, view: 'codespaces' }));
    if (mobile) setNavOpen(false);
  };
  const goArcade = () => {
    setNav((n) => ({ ...n, view: 'arcade' }));
    if (mobile) setNavOpen(false);
  };
  const goShop = () => {
    setNav((n) => ({ ...n, view: 'shop' }));
    if (mobile) setNavOpen(false);
  };
  const closeView = () => setNav((n) => ({ ...n, view: null }));
  const openCodespace = (csid) => {
    setNav((n) => ({ ...n, view: 'codespaces', csid: csid || null }));
    if (mobile) setNavOpen(false);
  };
  const selectChannel = (ch) => {
    if (ch.type === 'voice') {
      // Voice channels are drop-in rooms: join (never ring) and show the call view; no ChatView.
      joinCall(voiceScope(sid, ch.cid), uid, { kind: 'audio', ring: false })
        .then(() => setCallOpen(true))
        .catch((e) => toast(errMsg(e), 'error'));
      if (mobile) setNavOpen(false);
      return;
    }
    setNav((n) =>
      ch.type === 'code'
        ? { ...n, view: null, tab: 'collab', codeCid: { ...n.codeCid, [sid]: ch.cid } }
        : { ...n, view: null, tab: 'chat', chatCid: { ...n.chatCid, [sid]: ch.cid } },
    );
    if (mobile) setNavOpen(false);
  };
  const selectDm = (d) => {
    setNav((n) => ({ ...n, sid: null, dmId: d.dmId, gid: null, view: null }));
    if (mobile) setNavOpen(false);
  };
  const selectGroup = (g) => {
    setNav((n) => ({ ...n, sid: null, dmId: null, gid: g.gid, view: null }));
    if (mobile) setNavOpen(false);
  };
  const setTab = (t) => setNav((n) => ({ ...n, tab: t, view: null }));
  const openBookmark = (b) => {
    const c = b?.conv || {};
    setBookmarksOpen(false);
    if (c.kind === 'channel' && c.sid && c.cid) {
      setNav((n) => ({ ...n, sid: c.sid, dmId: null, gid: null, view: null, tab: 'chat', chatCid: { ...n.chatCid, [c.sid]: c.cid } }));
    } else if (c.kind === 'dm' && c.dmId) {
      selectDm({ dmId: c.dmId });
    } else if (c.kind === 'group' && c.gid) {
      selectGroup({ gid: c.gid }); // the group's live epoch/owner come from the normal group subscription
    }
    if (mobile) setNavOpen(false);
  };

  const messageUser = async (peerUid) => {
    try {
      const id = await openDm(uid, peerUid);
      setModal(null);
      setNav((n) => ({ ...n, sid: null, dmId: id, gid: null, view: null }));
      if (mobile) setNavOpen(false);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const enterServer = (s, cid, type = 'text') => {
    setNav((n) => ({
      ...n,
      sid: s,
      view: null,
      tab: type === 'code' ? 'collab' : 'chat',
      ...(cid ? (type === 'code' ? { codeCid: { ...n.codeCid, [s]: cid } } : { chatCid: { ...n.chatCid, [s]: cid } }) : {}),
    }));
    if (mobile) setNavOpen(false);
  };

  const openGame = (gameId) => {
    setPendingGameId(gameId);
    setModal(null);
    goArcade();
  };

  // Desktop notification click / command palette targets.
  const openConv = (c) => {
    if (c.kind === 'dm') setNav((n) => ({ ...n, sid: null, dmId: c.dmId, gid: null, view: null }));
    else if (c.kind === 'channel') setNav((n) => ({ ...n, sid: c.sid, view: null, tab: 'chat', chatCid: { ...n.chatCid, [c.sid]: c.cid } }));
    else if (c.kind === 'group') setNav((n) => ({ ...n, sid: null, dmId: null, gid: c.gid, view: null }));
    if (mobile) setNavOpen(false);
  };

  // Voice channels are drop-in rooms: show the server, join (never ring) and open the call view, the
  // same as clicking the channel in the sidebar. Resolves once joined; rejects with the join error.
  const openVoice = (s, cid) => {
    enterServer(s);
    return joinCall(voiceScope(s, cid), uid, { kind: 'audio', ring: false }).then(() => setCallOpen(true));
  };

  // ---------- calls ----------
  const openCall = (scope) => {
    const p = scope ? parseScope(scope) : null;
    if (p?.type === 'dm') openConv({ kind: 'dm', dmId: p.dmId });
    else if (p?.type === 'grp' || p?.type === 'group') openConv({ kind: 'group', gid: p.gid });
    else if (p?.sid) goServer(p.sid);
    setCallOpen(true);
    if (mobile) setNavOpen(false);
  };
  const onNotifNavigate = (item, target) => {
    const t = target ?? targetOfNotif(item);
    switch (t?.type) {
      case 'channel':
        enterServer(t.sid, t.cid, 'text');
        break;
      case 'server':
        goServer(t.sid);
        break;
      case 'dm':
        openConv({ kind: 'dm', dmId: t.dmId });
        break;
      case 'group':
        openConv({ kind: 'group', gid: t.gid });
        break;
      case 'call':
        if (t.dmId) openConv({ kind: 'dm', dmId: t.dmId });
        else if (t.gid) openConv({ kind: 'group', gid: t.gid });
        if (activeCall) setCallOpen(true);
        break;
      case 'friends':
        setNav((n) => ({ ...n, sid: null, dmId: null, gid: null, view: null }));
        break;
      case 'game':
        openGame(t.gameId);
        break;
      default:
        break;
    }
    if (mobile) setNavOpen(false);
  };

  const onPaletteNavigate = (t) => {
    switch (t?.type) {
      case 'server':
        goServer(t.sid);
        if (mobile) setNavOpen(false);
        break;
      case 'channel':
        if (t.channelType === 'voice') {
          // Same as clicking a voice channel in the sidebar: join (never ring) and show the call.
          openVoice(t.sid, t.cid).catch((e) => toast(errMsg(e), 'error'));
        } else {
          enterServer(t.sid, t.cid, t.channelType);
        }
        break;
      case 'dm':
        openConv({ kind: 'dm', dmId: t.dmId });
        break;
      case 'group':
        openConv({ kind: 'group', gid: t.gid });
        break;
      case 'codespace':
        openCodespace(t.csid);
        break;
      case 'action':
        if (t.id.startsWith('ext:')) {
          const a = getExt('paletteActions', t.id.slice(4));
          if (a && typeof a.run === 'function') runSafe(a.run, [wsCtx], (msg) => toast(msg, 'error'));
        } else if (t.id.startsWith('theme:')) themeActions.find((a) => a.id === `action:${t.id}`)?.run();
        else if (t.id === 'settings') setModal({ type: 'settings' });
        else if (t.id === 'snippets') setModal({ type: 'snippets' });
        else if (t.id === 'create-server') setModal({ type: 'createJoin' });
        else if (t.id === 'new-dm') setModal({ type: 'newDm' });
        else if (t.id === 'new-group') setModal({ type: 'newGroup' });
        else if (t.id === 'new-codespace') {
          goCodespaces();
          setCsCreate((x) => x + 1);
        } else if (t.id === 'shop') goShop();
        else if (t.id === 'arcade') goArcade();
        else if (t.id === 'toggle-preview') {
          // The open CollabView (if any) handles this and cancels the event.
          const ev = new CustomEvent(TOGGLE_PREVIEW_EVENT, { cancelable: true });
          if (window.dispatchEvent(ev)) toast('Open a code channel or codespace file to preview it', 'error');
        }
        break;
      default:
        break;
    }
  };

  // Round 3: WorkspaceContext (see src/lib/ext/workspaceContext.js). Functions read the latest
  // closures through a ref so the value only changes with me / nav / servers.
  const wsFns = useRef({});
  wsFns.current = { openConv, openVoice, toast, sid };
  const wsCtx = useMemo(() => ({
    me,
    nav,
    setNav,
    servers,
    openSettings: (tab) => setModal({ type: 'settings', tab: typeof tab === 'string' ? tab : undefined }),
    openServerSettings: (tab) => {
      if (wsFns.current.sid) setModal({ type: 'server', tab: typeof tab === 'string' ? tab : undefined });
    },
    openConv: (c) => wsFns.current.openConv(c || {}),
    openVoice: (s, cid) => wsFns.current.openVoice(s, cid),
    toast: (text, kind) => wsFns.current.toast(String(text ?? ''), kind === 'error' || kind === 'success' ? kind : 'info'),
  }), [me, nav, servers]);
  const extPalette = useRegistry('paletteActions');

  const paletteExtra = useMemo(
    () => [
      ...groups
        .filter((g) => g.name)
        .map((g) => ({
          id: `group:${g.gid}`,
          kind: 'group',
          title: g.name,
          subtitle: 'Group chat',
          keywords: ['group'],
          target: { type: 'group', gid: g.gid },
        })),
      ...codespaces
        .filter((c) => c.name)
        .map((c) => ({
          id: `codespace:${c.csid}`,
          kind: 'codespace',
          title: c.name,
          subtitle: 'Codespace',
          keywords: ['code', 'workspace'],
          target: { type: 'codespace', csid: c.csid },
        })),
    ],
    [groups, codespaces],
  );
  // Recomputed on open so "(current)" follows the theme.
  const themeActions = useMemo(() => themePaletteActions(), [paletteOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const paletteActions = useMemo(
    () => [
      { id: 'settings', title: 'Open settings', hint: 'Profile, GitHub token, keys', keywords: ['preferences', 'profile'] },
      { id: 'snippets', title: 'Snippet library', hint: 'Your private code snippets', keywords: ['code', 'vault'] },
      { id: 'new-codespace', title: 'New codespace', hint: 'Create an encrypted workspace', keywords: ['create'] },
      { id: 'new-group', title: 'New group chat', hint: 'Private, end-to-end encrypted', keywords: ['create', 'group'] },
      { id: 'shop', title: 'Open shop', hint: 'Themes, badges and other cosmetics', keywords: ['store', 'addons', 'cosmetics'] },
      { id: 'arcade', title: 'Open arcade', hint: 'Public games', keywords: ['games', 'play'] },
      { id: 'toggle-preview', title: 'Toggle preview', hint: 'Live preview of the open workspace', keywords: ['run', 'sandbox', 'console'] },
      { id: 'create-server', title: 'Create or join a server', keywords: ['invite', 'new'] },
      { id: 'new-dm', title: 'New direct message', keywords: ['dm', 'message'] },
      ...themeActions.map((a) => ({ id: a.id.replace(/^action:/, ''), title: a.title, hint: a.subtitle, keywords: a.keywords })),
      ...extPalette
        .filter((a) => a.title && typeof a.run === 'function' && passes(a.when, wsCtx))
        .map((a) => ({ id: `ext:${a.id}`, title: String(a.title), hint: a.hint, keywords: Array.isArray(a.keywords) ? a.keywords : [] })),
    ],
    [themeActions, extPalette, wsCtx],
  );
  const describeScope = useCallback((s) => notifySources.find((x) => x.scope === s)?.title, [notifySources]);

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
    const t = csMode
      ? 'Codespaces'
      : arcade
        ? 'Arcade'
        : shopMode
          ? 'Add-on shop'
          : sid
            ? channel?.name
              ? `${tab === 'chat' ? '#' : ''}${channel.name} · ${meta.name || ''}`
              : meta.name
            : gid
              ? group.name
              : dmPeer?.name;
    setTitlePage(t);
  }, [csMode, arcade, shopMode, sid, tab, channel?.name, meta.name, dmPeer?.name, gid, group.name]);

  useEffect(() => () => setTitlePage(''), []);

  // ---------- content ----------
  const chatConv = useMemo(() => {
    if (view) return null;
    if (!sid && gid) return group.status === 'ready' ? groupConv(group) : null;
    if (!sid && dmId && dmPeerUid) {
      return { kind: 'dm', dmId, peerUid: dmPeerUid, title: dmPeer?.name || 'Direct message', scope: dmScope(dmId) };
    }
    if (sid && channel && !channel.pending && !channel.failed) {
      return { kind: 'channel', sid, cid: channel.cid, title: channel.name, scope: channelScope(sid, channel.cid) };
    }
    return null;
  }, [view, sid, gid, group.status, group.epoch, group.name, group.ownerId, dmId, dmPeerUid, dmPeer?.name, channel?.cid, channel?.name, channel?.pending, channel?.failed]); // eslint-disable-line react-hooks/exhaustive-deps

  const admin = perms.manageChannels; // channel create/edit gates
  const nextPosition = channels.reduce((m, c) => Math.max(m, c.position), 0) + 1;

  let content;
  if (!sid && gid) {
    content =
      group.status === 'loading' ? (
        <Loading />
      ) : chatConv ? (
        <ChatView
          key={`${chatConv.scope}|${chatConv.epoch}`}
          conv={chatConv}
          me={me}
          onOpenGroupSettings={() => setModal({ type: 'group', gid, tab: 'overview' })}
          forwardTargets={forwardTargets}
        />
      ) : (
        <EmptyState icon="x" title="This group isn't available">You may have been removed, or it was deleted.</EmptyState>
      );
  } else if (!sid) {
    content = chatConv ? (
      <ChatView key={chatConv.scope} conv={chatConv} me={me} forwardTargets={forwardTargets} />
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
    content = <ChatView key={`${chatConv.scope}|${nonce}`} conv={chatConv} me={me} forwardTargets={forwardTargets} />;
  } else {
    content = (
      <Suspense fallback={<Loading />}>
        <CollabView key={`${sid}/${channel.cid}|${nonce}`} sid={sid} cid={channel.cid} me={me} serverName={meta.name || ''} />
      </Suspense>
    );
  }

  const rightContent =
    gid && !sid && rightPanel === 'members' ? (
      <GroupMembersPanel gid={gid} me={me} onMessage={messageUser} onManage={() => setModal({ type: 'group', gid, tab: 'members' })} />
    ) : rightPanel === 'members' && sid ? (
      <MemberList
        members={members}
        loading={memLoading}
        myUid={uid}
        onMessage={messageUser}
        sid={sid}
        meMember={meMember}
        roles={roles}
        timeouts={timeouts}
      />
    ) : rightPanel === 'chat' && chatConv && tab === 'collab' ? (
      <ErrorBoundary resetKey={chatConv.scope}>
        <ChatView key={`side-${chatConv.scope}|${nonce}`} conv={chatConv} me={me} forwardTargets={forwardTargets} />
      </ErrorBoundary>
    ) : null;

  const rightTitle =
    rightPanel === 'members' ? `Members — ${gid && !sid ? groupMembers.length : members.length}` : `# ${channel?.name || ''}`;

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

  const callScopeInfo = activeCall ? parseScope(activeCall.scope) : null;
  const activeCallLabel = !callScopeInfo
    ? ''
    : callScopeInfo.type === 'dm'
      ? (dmPeerProfiles[dms.find((d) => d.dmId === callScopeInfo.dmId)?.peer]?.name || 'Direct call')
      : callScopeInfo.type === 'grp'
        ? (groups.find((g) => g.gid === callScopeInfo.gid)?.name || 'Group call')
        : (callScopeInfo.sid === sid ? `#${channels.find((c) => c.cid === callScopeInfo.cid)?.name || 'voice'}` : 'Voice channel');
  if (callOpen && activeCall) content = <CallView title={activeCallLabel} onMinimize={() => setCallOpen(false)} />;
  const callButton = !sid && gid && group.status === 'ready'
    ? <CallButton scope={`grp_${gid}`} me={uid} onJoined={() => setCallOpen(true)} />
    : !sid && dmId && dmPeerUid
      ? <CallButton scope={`dm_${dmId}`} me={uid} onJoined={() => setCallOpen(true)} />
      : null;

  return (
    <WorkspaceContext.Provider value={wsCtx}>
    <div className={`ly-app ${mobile ? 'mobile' : ''} ${navOpen ? 'nav-open' : ''}`}>
      <AddonRuntime uid={uid} />
      <AppMounts />
      <div className="ly-nav" ref={navRef}>
        <ServerRail
          servers={servers}
          loading={serversLoading}
          activeSid={sid}
          codespacesActive={csMode}
          onCodespaces={goCodespaces}
          arcadeActive={arcade}
          onArcade={goArcade}
          shopActive={shopMode}
          onShop={goShop}
          homeUnread={homeUnread}
          onHome={goHome}
          onSelect={goServer}
          onStale={onStale}
          onCreateJoin={() => setModal({ type: 'createJoin' })}
          reads={reads}
          myUid={uid}
          refreshTick={refreshTick}
        />
        {!csMode && <div className="ly-sidebar">
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
              perms={perms}
              onCreateChannel={(t) => setModal({ type: 'channel', initialType: t })}
              onEditChannel={(ch) => setModal({ type: 'channel', channel: ch })}
              onOpenSettings={() => setModal({ type: 'server', tab: 'overview' })}
              onInvite={() => setModal({ type: 'server', tab: 'invites' })}
              onLeave={() => setModal({ type: 'leave' })}
            />
          ) : (
            <DmSidebar
              dms={visibleDms}
              loading={dmsLoading}
              error={dmsError}
              activeDmId={dmId}
              groups={groups}
              groupsLoading={groupsLoading}
              activeGid={gid}
              onSelectGroup={selectGroup}
              onNewGroup={() => setModal({ type: 'newGroup' })}
              reads={reads}
              myUid={uid}
              onSelect={selectDm}
              onNewDm={() => setModal({ type: 'newDm' })}
              onFriends={() => {
                setNav((n) => ({ ...n, dmId: null, gid: null, view: null }));
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
          <MiniCallBar label={activeCallLabel} onOpen={(scope) => openCall(scope)} hidden={callOpen} />
          <UserPanel me={me} onSettings={() => setModal({ type: 'settings' })} onAdmin={() => setModal({ type: 'admin' })} />
        </div>}
      </div>
      {mobile && navOpen && <div className="ly-scrim" onClick={() => setNavOpen(false)} />}

      {csMode ? (
        <main className="ly-main">
          <AnnouncementBanner />
          <ErrorBoundary resetKey={`cs|${nav.csid}`}>
            <Suspense fallback={<Loading />}>
              <CodespacesHome
                me={me}
                activeCsid={nav.csid}
                onOpen={openCodespace}
                createSignal={csCreate}
                footer={<UserPanel me={me} onSettings={() => setModal({ type: 'settings' })} onAdmin={() => setModal({ type: 'admin' })} />}
                showMenuButton={mobile}
                onMenu={() => setNavOpen(true)}
              />
            </Suspense>
          </ErrorBoundary>
        </main>
      ) : arcade ? (
        <main className="ly-main">
          <AnnouncementBanner />
          <div className="ly-content arcade">
            <ErrorBoundary resetKey="arcade">
              <Suspense fallback={<Loading />}>
                <GamesView
                  me={me}
                  openGameId={pendingGameId}
                  onOpenGameHandled={() => setPendingGameId(null)}
                  onMenu={mobile ? () => setNavOpen(true) : undefined}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      ) : shopMode ? (
        <main className="ly-main">
          <AnnouncementBanner />
          <ErrorBoundary resetKey="shop">
            <Suspense fallback={<Loading />}>
              <ShopView me={me} onClose={closeView} onMenu={mobile ? () => setNavOpen(true) : undefined} />
            </Suspense>
          </ErrorBoundary>
        </main>
      ) : (
      <main className="ly-main">
        <AnnouncementBanner />
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
          group={gid && group.status === 'ready' ? group : null}
          groupMemberCount={groupMembersLoading ? undefined : groupMembers.length}
          onGroupSettings={() => setModal({ type: 'group', gid, tab: 'overview' })}
          onOpenPalette={() => setPaletteOpen(true)}
          extraActions={
            <>
              <button className="btn ghost sm ly-icon-btn" onClick={() => setBookmarksOpen((o) => !o)} title="Saved messages" aria-label="Saved messages">🔖</button>
              {callButton}
              <NotificationBell me={uid} onNavigate={onNotifNavigate} global />
            </>
          }
        />
        <div className="ly-body">
          <div className={`ly-content ${tab}`}>
            <ErrorBoundary resetKey={`${sid}|${tab}|${channel?.cid}|${dmId}|${gid}`}>{content}</ErrorBoundary>
          </div>
          {wide && right}
        </div>
      </main>
      )}
      {!view && !wide && right && (
        <>
          <div className="ly-scrim right" onClick={() => setRightPanel(null)} />
          {right}
        </>
      )}

      {/* ---------- modals ---------- */}
      <LinkGuardHost />
      <CallAudio />
      <IncomingCallModal
        me={uid}
        onAccepted={(scope) => openCall(scope)}
        isBlocked={(u) => blocked.has(u)}
        muted={(scope) => isMuted(notifPrefs, scope)}
      />
      <Notifier me={me} sources={notifySources} activeScope={chatConv?.scope || null} reads={reads} onOpen={(src) => openConv(src.conv)} />
      {modal?.type === 'settings' && (
        <SettingsModal
          user={user}
          me={me}
          onClose={() => setModal(null)}
          onOpenShop={() => {
            setModal(null);
            goShop();
          }}
          onOpenAdmin={() => setModal({ type: 'admin' })}
          describeScope={describeScope}
          initialTab={modal.tab}
        />
      )}
      {modal?.type === 'admin' && <AdminPanel me={me} onClose={() => setModal(null)} onOpenGame={openGame} />}
      {modal?.type === 'snippets' && <SnippetLibraryModal me={me} onClose={() => setModal(null)} />}
      {modal?.type === 'newGroup' && (
        <CreateGroupModal
          me={me}
          onClose={() => setModal(null)}
          onCreated={(newGid) => {
            setModal(null);
            setNav((n) => ({ ...n, sid: null, dmId: null, gid: newGid, view: null }));
            if (mobile) setNavOpen(false);
            toast('Group created', 'success');
          }}
        />
      )}
      {modal?.type === 'group' && modal.gid && (
        <GroupSettingsModal
          me={me}
          gid={modal.gid}
          initialTab={modal.tab}
          onClose={() => setModal(null)}
          onLeft={() => {
            setModal(null);
            setNav((n) => ({ ...n, gid: null }));
          }}
          onDeleted={() => {
            setModal(null);
            setNav((n) => ({ ...n, gid: null }));
          }}
          onMessage={messageUser}
        />
      )}
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
            setNav((n) => ({ ...n, sid: null, dmId: id, gid: null, view: null }));
            if (mobile) setNavOpen(false);
          }}
        />
      )}
      {modal?.type === 'channel' && sid && (
        <ChannelModal
          sid={sid}
          me={me}
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
          meMember={meMember}
          roles={roles}
          timeouts={timeouts}
          perms={perms}
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
      {bookmarksOpen && (
        <Modal title="Saved messages" onClose={() => setBookmarksOpen(false)}>
          <BookmarksPanel me={me} onOpen={openBookmark} />
        </Modal>
      )}
      <ShortcutsOverlay />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        me={me}
        extraItems={paletteExtra}
        actions={paletteActions}
        onNavigate={onPaletteNavigate}
      />
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
    </WorkspaceContext.Provider>
  );
}
