// Runs one add-on document in SandboxFrame and serves the codehub bridge (see lib/bridge.js).
//
// Security: SandboxFrame keeps the existing model (sandbox="allow-scripts", no same-origin, CSP with
// connect-src 'none'). The bridge only binds the port from the FIRST hello that comes from this
// exact iframe's window with this render's token; nothing else on the window is listened to. Every
// call is permission-checked, validated and rate-limited by createBridgeHost. If the frame ever
// loads a second document (it navigated itself), the port is closed and the frame is removed.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import SandboxFrame from '../../../components/sandbox/SandboxFrame.jsx';
import { newToken } from '../../../lib/sandbox.js';
import { onThemeChange } from '../../../lib/theme.js';
import { addonDocument, createBridgeHost, isHello, readTheme } from '../lib/bridge.js';
import { normalizePerms } from '../lib/manifest.js';

export function currentTheme() {
  if (typeof document === 'undefined') return readTheme(() => '', 'dark');
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  return readTheme((n) => cs.getPropertyValue(n), root.getAttribute('data-theme'));
}

/**
 * Props:
 *   code       the add-on's HTML document
 *   perms      granted permissions
 *   handlers   { ready?, context(), messages(n), insertText(t), sendMessage(t), storage(op, key, value) }
 *              (read through a ref: may change every render)
 *   context    the current { kind, name, me, scope }; changes are pushed as 'context' events
 *   messagesKey  changes when the conversation's messages change (pushed as a 'messages' event
 *              with { count } to add-ons holding readMessages)
 *   title      accessible name of the frame
 *   preview    builder preview: forward console output to onConsole(level, args)
 *   onStopped(reason)  the frame was stopped ('navigated')
 */
export default function AddonFrame({ code, perms, handlers, context, messagesKey, messagesCount = 0, title, preview = false, onConsole, onStopped, runKey = 0 }) {
  const permsKey = normalizePerms(perms).join(',');
  // A fresh token (and frame) for every document, permission set or restart.
  const token = useMemo(() => newToken(), [code, runKey, permsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const html = useMemo(() => addonDocument(code, token, { console: preview }), [code, token, preview]);
  const frameRef = useRef(null);
  const portRef = useRef(null);
  const [stoppedFor, setStoppedFor] = useState(null);
  const stopped = stoppedFor === token;

  const live = useRef({});
  live.current = { handlers, context, onConsole, onStopped, preview, perms: normalizePerms(perms) };

  useLayoutEffect(() => {
    let dead = false;
    let port = null;
    let loads = 0;
    const el = frameRef.current?.element || null;
    const h = () => live.current.handlers || {};
    const host = createBridgeHost({
      perms: live.current.perms,
      handlers: {
        ready: () => h().ready?.() ?? true,
        context: () => live.current.context,
        theme: () => currentTheme(),
        messages: (n) => h().messages(n),
        insertText: (t) => h().insertText(t),
        sendMessage: (t) => h().sendMessage(t),
        storage: (op, key, value) => h().storage(op, key, value),
      },
    });

    const onMessage = (e) => {
      if (dead || port) return;
      const win = frameRef.current?.element?.contentWindow;
      if (!win || e.source !== win || !isHello(e.data, token)) return;
      const p = e.ports && e.ports[0];
      if (!p) return;
      port = p;
      portRef.current = p;
      p.onmessage = async (ev) => {
        const d = ev.data;
        if (d && typeof d === 'object' && typeof d.log === 'string') {
          if (live.current.preview && Array.isArray(d.args)) {
            live.current.onConsole?.(['log', 'info', 'warn', 'error'].includes(d.log) ? d.log : 'log', d.args.slice(0, 10).map((a) => String(a).slice(0, 2000)));
          }
          return;
        }
        const reply = await host.handle(d);
        if (reply && !dead) {
          try {
            p.postMessage(reply);
          } catch {
            /* frame gone */
          }
        }
      };
      p.postMessage({ event: 'init', data: { perms: live.current.perms, theme: currentTheme(), context: live.current.context, scope: live.current.context?.scope || '' } });
    };

    const onLoad = () => {
      loads += 1;
      if (loads > 1 && !dead) {
        dead = true;
        try {
          port?.close();
        } catch {
          /* already closed */
        }
        portRef.current = null;
        setStoppedFor(token);
        live.current.onStopped?.('navigated');
      }
    };

    window.addEventListener('message', onMessage);
    el?.addEventListener('load', onLoad);
    return () => {
      dead = true;
      window.removeEventListener('message', onMessage);
      el?.removeEventListener('load', onLoad);
      try {
        port?.close();
      } catch {
        /* already closed */
      }
      portRef.current = null;
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (msg) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      /* closed */
    }
  };

  // Theme: app theme switches and shop themes (inline CSS variables on <html>).
  useEffect(() => {
    let last = JSON.stringify(currentTheme());
    let timer = null;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const t = currentTheme();
        const s = JSON.stringify(t);
        if (s !== last) {
          last = s;
          post({ event: 'theme', data: t });
        }
      }, 60);
    };
    const offTheme = onThemeChange(check);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] });
    return () => {
      clearTimeout(timer);
      offTheme();
      mo?.disconnect();
    };
  }, [token]);

  const contextKey = JSON.stringify(context || null);
  const firstContext = useRef(true);
  useEffect(() => {
    if (firstContext.current) {
      firstContext.current = false;
      return;
    }
    post({ event: 'context', data: context });
  }, [contextKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const canRead = live.current.perms.includes('readMessages');
  useEffect(() => {
    if (canRead && messagesKey !== undefined) post({ event: 'messages', data: { count: messagesCount } });
  }, [messagesKey, canRead]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stopped) {
    return (
      <div className="ad-stopped" role="alert">
        <strong>Stopped</strong>
        <span>This add-on tried to load another page, so Codehub closed it. Add-ons must stay inside their sandbox.</span>
      </div>
    );
  }
  return <SandboxFrame key={token} ref={frameRef} html={html} mode="game" title={title} className="ad-frame" />;
}
