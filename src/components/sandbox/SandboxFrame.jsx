// The one place untrusted HTML is rendered. See src/lib/sandbox.js for the security model.
//
// Props:
//   html       unwrapped document (game code or a preview bundle); CSP + bridge are added here
//   mode       'game' (default) | 'preview'
//   onConsole  preview only: ({ level, args: [string] }) => void. Called for messages that come from
//              THIS frame's window and carry this render's token. Values are strings; render as text.
//   title      accessible name of the frame
//   className  extra class on the iframe
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { SANDBOX, buildSrcdoc, newToken } from '../../lib/sandbox.js';
import './sandbox.css';

const LEVELS = new Set(['log', 'info', 'warn', 'error', 'clear']);

const SandboxFrame = forwardRef(function SandboxFrame({ html, mode = 'game', onConsole, title = 'Sandboxed app', className = '' }, ref) {
  const frameRef = useRef(null);
  const preview = mode === 'preview';

  // A fresh token for every document we render: a stale frame (or any other window) can't inject
  // lines into the console of a newer run.
  const token = useMemo(() => newToken(), [html, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(() => buildSrcdoc(html, { mode: preview ? 'preview' : 'game', token }), [html, preview, token]);

  const onConsoleRef = useRef(onConsole);
  onConsoleRef.current = onConsole;

  useEffect(() => {
    // Game mode: no listener at all, every message from the frame is ignored.
    if (!preview) return undefined;
    const onMessage = (e) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || d.__sbx !== token) return;
      const level = LEVELS.has(d.level) ? d.level : 'log';
      const args = Array.isArray(d.args) ? d.args.slice(0, 20).map((a) => String(a).slice(0, 4000)) : [];
      onConsoleRef.current?.({ level, args });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview, token]);

  useImperativeHandle(ref, () => ({
    focus: () => frameRef.current?.focus(),
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
      sandbox={SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      allow=""
    />
  );
});

export default SandboxFrame;
