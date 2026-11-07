// The one place untrusted HTML is rendered. See src/lib/sandbox.js for the security model.
//
// Props:
//   html       unwrapped document (game code or a preview bundle); CSP + bridge/runtime are added here
//   profile    'strict' (default: add-ons; exactly the original sandbox, CSP and attributes) |
//              'play' (games, live preview, chat Run: CDN allowlist, compat runtime, pointer lock,
//              fullscreen/gamepad/autoplay; see src/lib/sandboxPlay.js) |
//              'snippet' (chat Run: the play CSP and runtime with the strict iframe attributes)
//   mode       'game' (default) | 'preview' (console bridge)
//   onConsole  preview only: ({ level, args: [string] }) => void. Called for messages that come from
//              THIS frame's window and carry this render's token. Values are strings; render as text.
//   onRuntime  play + game mode: ({ kind: 'start' | 'error' | 'blocked', message?, url?, directive? }).
//              'start' when a document starts (also after the game reloaded itself); then uncaught
//              errors and loads the sandbox blocked. (In preview mode these go to the console.)
//   storage    play only: { load() -> { local, session }, save?(area, data) }. load() gives the initial
//              localStorage/sessionStorage contents of each render; with save, the frame's changes
//              are sent back (validated strings within the size cap). A game that reloads itself is
//              re-rendered from load() so it never resumes from stale data.
//   onLoad     the iframe's load event
//   title      accessible name of the frame
//   className  extra class on the iframe
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { buildSrcdoc, frameAttrs, isPlayProfile, newToken } from '../../lib/sandbox.js';
import { readRuntimeMessage } from '../../lib/sandboxPlay.js';
import './sandbox.css';

const LEVELS = new Set(['log', 'info', 'warn', 'error', 'clear']);
// Messages a removed frame sends while it unloads (its last storage flush) are accepted this long.
const UNLOAD_GRACE_MS = 1500;

const SandboxFrame = forwardRef(function SandboxFrame(
  { html, profile = 'strict', mode = 'game', onConsole, onRuntime, storage, onLoad, title = 'Sandboxed app', className = '' },
  ref,
) {
  const frameRef = useRef(null);
  const preview = mode === 'preview';
  const play = isPlayProfile(profile);
  const attrs = frameAttrs(play ? profile : 'strict');
  const [reloads, setReloads] = useState(0);

  const storageRef = useRef(storage);
  storageRef.current = storage;
  const persist = play && typeof storage?.save === 'function';

  // A fresh token for every document we render: a stale frame (or any other window) can't inject
  // lines into the console of a newer run or write into its storage.
  const token = useMemo(() => newToken(), [html, mode, profile, reloads]); // eslint-disable-line react-hooks/exhaustive-deps
  // The storage a document was rendered with, bound to its token: that document's messages can only
  // ever reach this storage, even if the `storage` prop later points somewhere else (another game)
  // while the old document still runs or flushes on unload.
  const bound = useMemo(() => ({ token, storage: storageRef.current }), [token]);
  const srcDoc = useMemo(() => {
    if (!play) return buildSrcdoc(html, { mode: preview ? 'preview' : 'game', token });
    let initial = {};
    try {
      initial = bound.storage?.load?.() || {};
    } catch {
      initial = {};
    }
    return buildSrcdoc(html, {
      profile: 'play',
      mode: preview ? 'preview' : 'game',
      token,
      storage: { persist, local: initial.local, session: initial.session },
    });
  }, [html, preview, play, token, persist, bound]);

  const cbRef = useRef({ onConsole, onRuntime });
  cbRef.current = { onConsole, onRuntime };

  useEffect(() => {
    // Strict game mode (add-ons): no listener at all, every message from the frame is ignored.
    if (!preview && !play) return undefined;
    const win = frameRef.current?.contentWindow || null;
    const store = bound.token === token ? bound.storage : null;
    let firstInst = null;
    let stale = false; // the document reloaded itself: drop its messages until the re-render
    let closing = false;
    const onMessage = (e) => {
      const current = frameRef.current?.contentWindow || null;
      if (!e.source || (e.source !== current && e.source !== win)) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || d.__sbx !== token) return;
      if (play && typeof d.kind === 'string') {
        const msg = readRuntimeMessage(d);
        if (!msg) return;
        if (msg.kind === 'hello') {
          if (closing) return;
          if (firstInst === null) firstInst = msg.inst;
          else if (msg.inst !== firstInst) {
            if (persist) {
              stale = true;
              setReloads((n) => n + 1);
              return;
            }
            firstInst = msg.inst;
          }
          cbRef.current.onRuntime?.({ kind: 'start' });
          return;
        }
        if (stale) return;
        if (msg.kind === 'storage') {
          if (persist) store?.save?.(msg.area, msg.data);
          return;
        }
        if (!closing && !preview) cbRef.current.onRuntime?.(msg);
        return;
      }
      if (!preview || closing) return;
      const level = LEVELS.has(d.level) ? d.level : 'log';
      const args = Array.isArray(d.args) ? d.args.slice(0, 20).map((a) => String(a).slice(0, 4000)) : [];
      cbRef.current.onConsole?.({ level, args });
    };
    window.addEventListener('message', onMessage);
    return () => {
      if (!persist) {
        window.removeEventListener('message', onMessage);
        return;
      }
      closing = true;
      setTimeout(() => window.removeEventListener('message', onMessage), UNLOAD_GRACE_MS);
    };
  }, [preview, play, persist, token, bound]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = frameRef.current;
      if (!el) return;
      el.focus();
      try {
        el.contentWindow?.focus();
      } catch {
        /* the element focus is enough */
      }
    },
    get element() {
      return frameRef.current;
    },
  }));

  return (
    <iframe
      ref={frameRef}
      key={token}
      className={`sbx-frame ${className}`}
      title={title}
      sandbox={attrs.sandbox}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      allow={attrs.allow}
      onLoad={onLoad}
    />
  );
});

export default SandboxFrame;
