// Runs an installed add-on (personal or server) inside a chat panel: loads the pinned copy, checks
// its SHA-256, asks a member for consent to a server add-on's permissions on first open, and serves
// the bridge calls against the current conversation (ChatContext).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyStorageOp, BridgeError, toAddonContext, toAddonMessages } from '../lib/bridge.js';
import { permsCover } from '../lib/manifest.js';
import {
  loadPinnedCode, loadStorage, personalPinPath, saveConsent, saveStorage, serverPinPath, setConsentAutoSend,
  setPersonalAutoSend, storageKeyFor, useConsent, useManifest,
} from '../lib/store.js';
import { openHub } from '../lib/hub.js';
import AddonFrame from './AddonFrame.jsx';
import Dialog from './Dialog.jsx';
import { AddonIcon, PermList, errText } from './bits.jsx';

/**
 * Props: { scope: 'personal'|'server', sid?, install (parseInstall result), ctx (ChatContext), onBack? }
 */
export default function AddonRunner({ scope, sid, install, ctx, onBack }) {
  const { consent, loading: consentLoading } = useConsent(scope === 'server' ? sid : null, install.id);
  const needsConsent = scope === 'server' && !consentLoading && !(consent && permsCover(consent.perms, install.perms));

  if (scope === 'server' && consentLoading) return <div className="ad-center"><div className="spinner" aria-label="Loading" /></div>;
  if (needsConsent) return <ConsentCard sid={sid} install={install} consent={consent} onBack={onBack} />;
  return <Runner scope={scope} sid={sid} install={install} ctx={ctx} onBack={onBack} auto={scope === 'server' ? !!consent?.auto : install.auto} />;
}

function ConsentCard({ sid, install, consent, onBack }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const again = !!consent;
  return (
    <section className="ad-consent" aria-labelledby={`ad-consent-${install.id}`}>
      <div className="ad-run-title">
        <AddonIcon icon={install.icon} />
        <div>
          <h4 id={`ad-consent-${install.id}`}>{install.name}</h4>
          <span className="muted">{install.v ? `v${install.v} · ` : ''}Installed by this server</span>
        </div>
      </div>
      <p>
        {again
          ? 'This add-on was updated with new permissions. Review them before you open it again:'
          : 'A server manager installed this add-on. Before it opens for you, here is what it may do:'}
      </p>
      <PermList perms={install.perms} />
      <p className="ad-hint muted">
        It runs in a locked-down sandbox in your browser, with no network access. You can change your mind any time in
        Settings → Add-on apps.
      </p>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="ad-actions">
        {onBack && <button type="button" className="btn ghost" onClick={onBack}>Not now</button>}
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await saveConsent(sid, install.id, { perms: install.perms, sha: install.sha, auto: false });
            } catch (e) {
              setErr(errText(e));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Allow and open'}
        </button>
      </div>
    </section>
  );
}

function Runner({ scope, sid, install, ctx, onBack, auto }) {
  const [code, setCode] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [runKey, setRunKey] = useState(0);
  const [confirm, setConfirm] = useState(null); // { text, resolve }
  const confirmRef = useRef(null);
  const [allowAuto, setAllowAuto] = useState(false);
  const { manifest } = useManifest(scope === 'personal' ? install.id : null);

  useEffect(() => {
    let off = false;
    setCode(null);
    setLoadErr('');
    const path = scope === 'server' ? serverPinPath(sid, install.id) : personalPinPath(install.id);
    loadPinnedCode(path, install.sha).then(
      (c) => !off && setCode(c),
      (e) => !off && setLoadErr(errText(e)),
    );
    return () => {
      off = true;
    };
  }, [scope, sid, install.id, install.sha]);

  // Latest values for the bridge handlers (they live as long as the frame).
  const live = useRef({});
  live.current = { ctx, auto, install, scope, sid };

  // ---------- storage: lazily decrypted, saved (debounced) after changes ----------
  const skey = storageKeyFor(scope, install.id, sid);
  const store = useRef({ key: null, map: null, loading: null, saving: Promise.resolve(), timer: null });
  const flush = useCallback(() => {
    const s = store.current;
    clearTimeout(s.timer);
    s.timer = null;
    if (!s.dirty) return;
    s.dirty = false;
    const map = s.map;
    const key = s.key;
    s.saving = s.saving.then(() => saveStorage(key, map)).catch((e) => {
      console.error('[addons] storage save failed', e);
      live.current.ctx?.toast?.(`${live.current.install.name}: could not save its data (${errText(e)})`);
    });
  }, []);
  useEffect(() => {
    store.current = { key: skey, map: null, loading: null, saving: Promise.resolve(), timer: null, dirty: false };
    return () => flush();
  }, [skey, flush]);

  const handlers = useMemo(() => ({
    messages: (n) => toAddonMessages(live.current.ctx.messages, live.current.ctx.profiles, n),
    insertText: (text) => {
      const c = live.current.ctx;
      if (!c.canSend) throw new BridgeError('UNAVAILABLE', 'You can’t write in this conversation right now.');
      c.insertText(text);
      return true;
    },
    sendMessage: async (text) => {
      const { ctx: c, auto: autoSend, install: inst } = live.current;
      if (!c.canSend) throw new BridgeError('UNAVAILABLE', 'You can’t send messages in this conversation right now.');
      if (!autoSend) {
        if (confirmRef.current) throw new BridgeError('BUSY', 'Another message is waiting for your confirmation.');
        const ok = await new Promise((resolve) => {
          confirmRef.current = { text, resolve };
          setAllowAuto(false);
          setConfirm(confirmRef.current);
        });
        if (!ok) throw new BridgeError('CANCELLED', 'You chose not to send that message.');
      }
      const sent = await live.current.ctx.send({ text, extra: { addon: { id: inst.id, name: inst.name, icon: inst.icon } } });
      if (!sent) throw new BridgeError('FAILED', 'The message was not sent.');
      return true;
    },
    storage: async (op, key, value) => {
      const s = store.current;
      if (!s.map) {
        s.loading = s.loading || loadStorage(s.key).then((m) => {
          s.map = m;
        });
        try {
          await s.loading;
        } catch (e) {
          s.loading = null;
          throw new BridgeError('UNAVAILABLE', errText(e));
        }
      }
      const r = applyStorageOp(s.map, op, key, value);
      if (r.changed) {
        s.map = r.map;
        s.dirty = true;
        clearTimeout(s.timer);
        s.timer = setTimeout(flush, 400);
      }
      return r.result;
    },
  }), [flush]);

  const context = useMemo(() => toAddonContext(ctx.conv, ctx.me, scope), [ctx.conv, ctx.me, scope]);
  const msgs = ctx.messages || [];
  const messagesKey = `${msgs.length}:${msgs[msgs.length - 1]?.mid || ''}:${msgs[msgs.length - 1]?.editedAt || ''}`;

  // A pending confirmation is declined if the panel closes.
  useEffect(() => () => confirmRef.current?.resolve(false), []);

  const answer = async (ok) => {
    const c = confirmRef.current;
    if (!c) return;
    confirmRef.current = null;
    setConfirm(null);
    if (ok && allowAuto) {
      try {
        if (scope === 'server') await setConsentAutoSend(sid, install.id, true);
        else await setPersonalAutoSend(install.id, true);
      } catch (e) {
        ctx.toast(errText(e));
      }
    }
    c.resolve(ok);
  };

  const update = scope === 'personal' && manifest && manifest.sha !== install.sha ? manifest : null;

  return (
    <section className="ad-run" aria-label={`${install.name} add-on`}>
      <div className="ad-run-bar">
        {onBack && (
          <button type="button" className="ad-icon-btn" onClick={onBack} aria-label="Back to the add-on list" title="Back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
        )}
        <AddonIcon icon={install.icon} size="sm" />
        <span className="ad-run-name">{install.name}</span>
        {install.v && <span className="ad-run-v muted">v{install.v}</span>}
        <span className={`ad-chip ${scope === 'server' ? 'server' : 'quiet'}`}>{scope === 'server' ? 'Server' : 'Personal'}</span>
        <button type="button" className="ad-icon-btn" onClick={() => setRunKey((k) => k + 1)} aria-label={`Restart ${install.name}`} title="Restart">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
        </button>
      </div>
      {update && (
        <div className="ad-update-note">
          <span>Version {update.version} is available. You keep running the version you approved until you review it.</span>
          <button type="button" className="btn sm" onClick={() => openHub({ view: 'details', id: install.id })}>Review</button>
        </div>
      )}
      <div className="ad-run-frame">
        {loadErr ? (
          <p className="error-text" role="alert">{loadErr}</p>
        ) : code === null ? (
          <div className="ad-center"><div className="spinner" aria-label="Loading add-on" /></div>
        ) : (
          <AddonFrame
            code={code}
            perms={install.perms}
            handlers={handlers}
            context={context}
            messagesKey={messagesKey}
            messagesCount={msgs.length}
            title={`${install.name} (add-on)`}
            runKey={runKey}
          />
        )}
      </div>
      {confirm && (
        <Dialog title={`Send a message for ${install.name}?`} onClose={() => answer(false)} role="alertdialog" initialFocus=".ad-send-no">
          <p>
            <strong>{install.name}</strong> wants to post this as you in <strong>{ctx.conv.kind === 'channel' ? `#${ctx.conv.name}` : ctx.conv.name || 'this conversation'}</strong>:
          </p>
          <blockquote className="ad-quote">{confirm.text}</blockquote>
          <label className="ad-check">
            <input type="checkbox" checked={allowAuto} onChange={(e) => setAllowAuto(e.target.checked)} />
            <span>Allow {install.name} to send without asking</span>
          </label>
          <div className="ad-actions">
            <button type="button" className="btn ghost ad-send-no" onClick={() => answer(false)}>Don’t send</button>
            <button type="button" className="btn primary" onClick={() => answer(true)}>Send</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
