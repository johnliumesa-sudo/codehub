import { useEffect, useMemo, useState } from 'react';
import {
  describePref,
  notificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  setNotifSettings,
  setScopePref,
  showNotification,
  useNotifPrefs,
} from '../../lib/notify.js';
import './safety.css';

function Toggle({ checked, disabled, onChange, title, children }) {
  return (
    <label className={`sf-switch-row ${disabled ? 'disabled' : ''}`}>
      <span className="sf-switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="sf-switch-track" aria-hidden="true"><span className="sf-switch-thumb" /></span>
      </span>
      <span className="sf-switch-text">
        <strong>{title}</strong>
        <span className="muted small">{children}</span>
      </span>
    </label>
  );
}

function scopeKind(scope) {
  if (scope.startsWith('dm_')) return 'Direct message';
  if (scope.startsWith('grp_')) return 'Group';
  if (scope.startsWith('srv_')) return 'Whole server';
  if (scope.startsWith('cs_')) return 'Codespace';
  return 'Channel';
}

/**
 * Settings → Notifications (F19).
 * Props: user (Firebase user) or me ({ uid }); optional describeScope(scope) => string to show decrypted
 * conversation names (names are E2EE, so by default only the kind of conversation is shown).
 */
export default function NotificationsTab({ user, me, describeScope }) {
  const uid = user?.uid || me?.uid || null;
  const prefs = useNotifPrefs(uid);
  const [perm, setPerm] = useState(notificationPermission);
  const [error, setError] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const s = prefs.settings;

  useEffect(() => {
    // Permission can change from the browser's site settings while the tab is open.
    const on = () => setPerm(notificationPermission());
    window.addEventListener('focus', on);
    let status;
    navigator.permissions?.query?.({ name: 'notifications' }).then((st) => {
      status = st;
      st.onchange = on;
    }).catch(() => {});
    return () => {
      window.removeEventListener('focus', on);
      if (status) status.onchange = null;
    };
  }, []);

  const save = async (patch) => {
    setError('');
    try {
      await setNotifSettings(uid, patch);
    } catch (e) {
      setError(e?.message || 'Could not save');
    }
  };

  const toggleDesktop = async (on) => {
    if (on) {
      const p = await requestNotificationPermission();
      setPerm(p);
      if (p !== 'granted') {
        setError(p === 'denied'
          ? 'Your browser blocks notifications for this site. Allow them in the site settings, then try again.'
          : p === 'unsupported' ? 'This browser does not support desktop notifications.' : 'Permission was not granted.');
        return;
      }
    }
    save({ desktop: on });
  };

  const test = () => {
    const n = showNotification('Codehub', { body: s.preview ? 'This is what a message preview looks like.' : 'Sent you a message', tag: 'codehub-test' });
    setTestMsg(n ? 'Sent — check your system notifications.' : 'Your browser refused to show it (some mobile browsers need an installed app).');
    setTimeout(() => setTestMsg(''), 4000);
  };

  const muted = useMemo(() => {
    const now = Date.now();
    return Object.entries(prefs.scopes)
      .filter(([, p]) => !(typeof p.until === 'number' && p.until <= now))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [prefs.scopes]);

  if (!uid) return null;

  return (
    <div className="settings-section sf-notifs">
      <div className="settings-card">
        <Toggle
          checked={s.desktop && perm === 'granted'}
          disabled={prefs.loading || !notificationsSupported()}
          onChange={toggleDesktop}
          title="Enable desktop notifications"
        >
          {!notificationsSupported()
            ? 'Not supported in this browser.'
            : perm === 'denied'
              ? 'Blocked by your browser — allow notifications for this site in its settings.'
              : 'Get a system notification for new messages while Codehub is open in a tab.'}
        </Toggle>
        <Toggle checked={s.preview} disabled={prefs.loading} onChange={(v) => save({ preview: v })} title="Show message preview">
          Off by default. When on, decrypted message text and conversation names appear in system notifications —
          and therefore on your lock screen and in the OS notification history.
        </Toggle>
        <Toggle checked={s.mentionsOnly} disabled={prefs.loading} onChange={(v) => save({ mentionsOnly: v })} title="Mentions only">
          Only notify for @mentions, @everyone and direct messages.
        </Toggle>
        <div className="settings-actions">
          {testMsg && <span className="settings-ok">{testMsg}</span>}
          <button type="button" className="btn sm" disabled={perm !== 'granted'} onClick={test}>Send test notification</button>
        </div>
        {error && <p className="error-text">{error}</p>}
        <p className="settings-note">
          There is no push server: notifications only arrive while at least one Codehub tab is open and unlocked.
          Messages are decrypted on this device; nothing extra is sent anywhere.
        </p>
      </div>

      <div className="settings-card">
        <h3 className="sf-card-title">Muted conversations</h3>
        <p className="settings-note">Muted conversations don&apos;t notify and don&apos;t show unread badges. Use the bell in a conversation or server menu to change this.</p>
        {muted.length === 0 ? (
          <p className="muted sf-empty">Nothing is muted.</p>
        ) : (
          <ul className="sf-list">
            {muted.map(([scope, p]) => (
              <li key={scope} className="sf-row">
                <span className="sf-row-text">
                  <span className="sf-row-name">{describeScope?.(scope) || scopeKind(scope)}</span>
                  <span className="sf-row-sub">{describePref(p)}</span>
                </span>
                <button type="button" className="btn sm ghost" onClick={() => setScopePref(uid, scope, null).catch((e) => setError(e?.message || 'Could not update'))}>
                  {p.level === 'all' ? 'Reset' : 'Unmute'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
