import { useEffect, useRef, useState } from 'react';
import { analyzeLink, shouldGuard, trust } from '../../lib/linkguard.js';
import { Modal, copyText } from '../layout/ui.jsx';
import './safety.css';

const MAX_TEXT = 300;

// Splits a URL for display so the real hostname stands out: prefix | host | rest.
function urlParts(url) {
  const user = url.username ? `${url.username}${url.password ? ':' + url.password : ''}@` : '';
  return {
    prefix: `${url.protocol}//${user}`,
    host: url.hostname,
    rest: `${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}${url.hash}`,
  };
}

function GuardModal({ info, onClose }) {
  const [always, setAlways] = useState(false);
  const [copied, setCopied] = useState(false);
  const parts = urlParts(info.url);

  const open = () => {
    if (always && info.trustable) trust(info.domain);
    window.open(info.href, '_blank', 'noopener,noreferrer');
    onClose();
  };
  const copy = async () => {
    const ok = await copyText(info.href);
    setCopied(ok ? 'Copied' : 'Copy failed');
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Modal
      title="Open external link?"
      onClose={onClose}
      className="sf-guard-modal"
      footer={(
        <div className="sf-guard-foot">
          <button type="button" className="btn ghost" onClick={copy}>{copied || 'Copy link'}</button>
          <span className="sf-grow" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${info.warnings.some((w) => w.severity === 'high') ? 'danger' : 'primary'}`} onClick={open}>
            Open
          </button>
        </div>
      )}
    >
      <p className="muted sf-guard-lead">This link leaves Codehub and opens:</p>
      <div className="sf-guard-host" title="The site this link really opens">{info.hostname}</div>
      <div className="sf-guard-url">
        <span className="sf-url-dim">{parts.prefix}</span>
        <mark className="sf-url-host">{parts.host}</mark>
        <span className="sf-url-dim">{parts.rest}</span>
      </div>
      {info.warnings.length > 0 && (
        <ul className="sf-guard-warnings">
          {info.warnings.map((w) => (
            <li key={w.code} className={`sf-warn ${w.severity}`}>
              <span className="sf-warn-icon" aria-hidden="true">!</span>
              <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}
      {info.trustable ? (
        <label className="sf-check">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          <span>Always trust <b>{info.domain}</b> on this device</span>
        </label>
      ) : (
        <p className="settings-note sf-guard-note">This link can&apos;t be added to trusted domains because of the warnings above.</p>
      )}
    </Modal>
  );
}

/**
 * Mount once (in Workspace). Intercepts clicks and middle-clicks on external http(s) links anywhere in
 * the document (capture phase, before React handlers) and asks before opening them. Opt out for app-
 * owned links with a `data-trusted-link` attribute on the anchor or any ancestor.
 */
export default function LinkGuardHost() {
  const [info, setInfo] = useState(null);
  const openRef = useRef(false);
  openRef.current = !!info;

  useEffect(() => {
    const handler = (e) => {
      if (e.defaultPrevented) return;
      if (e.type === 'click' && e.button !== 0) return;
      if (e.type === 'auxclick' && e.button !== 1) return;
      const target = e.target instanceof Element ? e.target : e.target?.parentElement;
      const a = target?.closest?.('a[href]');
      if (!a || a.closest('[data-trusted-link]')) return;
      if (a.hasAttribute('download')) return;
      const text = (a.textContent || '').trim().slice(0, MAX_TEXT);
      const res = analyzeLink(a.href, text);
      if (!shouldGuard(res)) return;
      e.preventDefault();
      if (openRef.current) return; // one prompt at a time
      setInfo(res);
    };
    document.addEventListener('click', handler, true);
    document.addEventListener('auxclick', handler, true);
    return () => {
      document.removeEventListener('click', handler, true);
      document.removeEventListener('auxclick', handler, true);
    };
  }, []);

  if (!info) return null;
  return <GuardModal key={info.href} info={info} onClose={() => setInfo(null)} />;
}
