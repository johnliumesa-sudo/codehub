// Round 3: chat extension slots (message badges/extras/actions, header buttons, side panels,
// composer buttons, local-only notices). All of them read the ChatContext that ChatView provides.
import { useEffect, useRef, useState } from 'react';
import { useRegistry } from '../../lib/ext/registry.js';
import { useChatCtx } from '../../lib/ext/chatContext.js';
import { ExtBoundary, ExtIcon, ExtMenu, ExtRender, passes, runSafe } from './ExtRender.jsx';
import './ext.css';

/** Messages are grouped under one header only while every messageBadges groupKey(m) agrees. */
export function messageGroupKey(m, entries) {
  let key = '';
  for (const e of entries) {
    if (typeof e.groupKey !== 'function') continue;
    try {
      const k = e.groupKey(m);
      if (k !== undefined && k !== null && k !== '') key += `${e.id}=${String(k)};`;
    } catch {
      key += `${e.id}=!;`;
    }
  }
  return key;
}

/** messageBadges: after the author name. */
export function MessageExtBadges({ m }) {
  const ctx = useChatCtx();
  const entries = useRegistry('messageBadges');
  if (!ctx || !entries.length) return null;
  return entries.map((e) => <ExtRender key={e.id} entry={e} args={[m, ctx]} />);
}

/** messageExtras: under the message body. */
export function MessageExtExtras({ m }) {
  const ctx = useChatCtx();
  const entries = useRegistry('messageExtras');
  if (!ctx || !entries.length) return null;
  return <div className="ext-msg-extras">{entries.map((e) => <ExtRender key={e.id} entry={e} args={[m, ctx]} />)}</div>;
}

/**
 * messageActions in the hover toolbar: entries with `inline: true` and an icon get their own button,
 * the rest go into a "More actions" menu.
 */
export function MessageExtActions({ m }) {
  const ctx = useChatCtx();
  const entries = useRegistry('messageActions');
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  useEffect(() => {
    const row = btn.current?.closest('.msg');
    if (!row || !open) return undefined;
    row.classList.add('ext-menu-open'); // keeps the toolbar shown while focus is in the menu
    return () => row.classList.remove('ext-menu-open');
  }, [open]);
  if (!ctx) return null;
  const usable = entries.filter((e) => typeof e.run === 'function' && e.label && passes(e.when, m, ctx));
  if (!usable.length) return null;
  const run = (e) => runSafe(e.run, [m, ctx], ctx.toast);
  const inline = usable.filter((e) => e.inline && e.icon);
  const more = usable.filter((e) => !(e.inline && e.icon));
  return (
    <>
      {inline.map((e) => (
        <button key={e.id} type="button" className="tb-btn ext-tb-btn" title={e.label} aria-label={e.label} onClick={() => run(e)}>
          <ExtIcon icon={e.icon} />
        </button>
      ))}
      {more.length > 0 && (
        <button
          ref={btn}
          type="button"
          className={`tb-btn${open ? ' on' : ''}`}
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <MoreIcon />
        </button>
      )}
      {open && (
        <ExtMenu
          anchor={btn.current}
          label="More actions"
          items={more.map((e) => ({ id: e.id, label: e.label, icon: e.icon, danger: e.danger, run: () => run(e) }))}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) requestAnimationFrame(() => btn.current?.focus());
          }}
        />
      )}
    </>
  );
}

/** chatHeaderButtons: toggle a chatPanels panel (entry.panel) or run an action. */
export function ChatHeaderExtButtons({ panel, onTogglePanel }) {
  const ctx = useChatCtx();
  const entries = useRegistry('chatHeaderButtons');
  if (!ctx) return null;
  return entries
    .filter((e) => e.label && (typeof e.run === 'function' || e.panel) && passes(e.when, ctx))
    .map((e) => {
      const on = !!e.panel && panel === e.panel;
      return (
        <button
          key={e.id}
          type="button"
          className={`chat-icon-btn ext-header-btn${on ? ' active' : ''}`}
          title={e.label}
          aria-label={e.label}
          aria-pressed={e.panel ? on : undefined}
          data-ext-panel={e.panel || undefined}
          onClick={(ev) => (e.panel ? onTogglePanel(e.panel, ev.currentTarget) : runSafe(e.run, [ctx], ctx.toast))}
        >
          <ExtIcon icon={e.icon || e.label.slice(0, 1)} />
        </button>
      );
    });
}

/** The open chatPanels panel, in the same right-side slot as Search / Pinned. */
export function ChatExtPanel({ id, onClose }) {
  const ctx = useChatCtx();
  const entries = useRegistry('chatPanels');
  const entry = entries.find((e) => e.id === id);
  const headRef = useRef(null);
  useEffect(() => {
    if (entry) headRef.current?.focus();
  }, [id, !!entry]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!entry) onClose(false); // unregistered while open
  }, [entry, onClose]);
  if (!entry || !ctx) return null;
  const title = entry.title || entry.id;
  return (
    <aside
      className="chat-side ext-panel"
      aria-label={title}
      data-ext-panel={id}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className="chat-side-head">
        <h3 ref={headRef} tabIndex={-1}>{title}</h3>
        <button type="button" className="chat-icon-btn" onClick={() => onClose(true)} title="Close" aria-label={`Close ${title}`}>✕</button>
      </div>
      <div className="chat-side-body ext-panel-body">
        <ExtRender entry={entry} args={[ctx]} label={title} notice resetKey={id} />
      </div>
    </aside>
  );
}

/**
 * chatMounts: { id, Component } (gets `ctx` as a prop) or { id, render(ctx) }, mounted once per open
 * ChatView inside its ChatContext, whether or not the composer is shown (timeout, block, missing key).
 * For chat-level hooks with no UI of their own (e.g. publishing the open chat for message links).
 */
export function ChatMounts() {
  const ctx = useChatCtx();
  const entries = useRegistry('chatMounts');
  if (!ctx) return null;
  return entries.map((e) => {
    if (typeof e.Component === 'function' || (e.Component && typeof e.Component === 'object')) {
      const C = e.Component;
      return (
        <ExtBoundary key={e.id} label={e.id}>
          <C ctx={ctx} />
        </ExtBoundary>
      );
    }
    return <ExtRender key={e.id} entry={e} args={[ctx]} />;
  });
}

/** composerButtons: beside the composer's own buttons. */
export function ComposerExtButtons({ disabled }) {
  const ctx = useChatCtx();
  const entries = useRegistry('composerButtons');
  if (!ctx) return null;
  return entries.map((e) => {
    if (typeof e.render === 'function') return <ExtRender key={e.id} entry={e} args={[ctx]} />;
    if (typeof e.run !== 'function' || !e.label || !passes(e.when, ctx)) return null;
    return (
      <button
        key={e.id}
        type="button"
        className="composer-btn ext-composer-btn"
        title={e.label}
        aria-label={e.label}
        disabled={disabled}
        onClick={() => runSafe(e.run, [ctx], ctx.toast)}
      >
        <ExtIcon icon={e.icon || e.label.slice(0, 1)} />
      </button>
    );
  });
}

/** Local-only notices (ctx.ephemeral): never sent, gone on reload. */
export function EphemeralStack({ items, onDismiss }) {
  if (!items.length) return null;
  return (
    <div className="ext-ephemeral-stack" aria-live="polite">
      {items.map(({ key, entry }) => (
        <section key={key} className="ext-ephemeral" aria-label={entry.title || 'Notice'}>
          <div className="ext-ephemeral-head">
            {entry.title && <strong>{entry.title}</strong>}
            <span className="ext-ephemeral-note">Only you can see this</span>
            <button type="button" className="ext-ephemeral-x" onClick={() => onDismiss(key)} aria-label={`Dismiss ${entry.title || 'notice'}`}>✕</button>
          </div>
          {typeof entry.text === 'string' && entry.text && <p className="ext-ephemeral-text">{entry.text}</p>}
          {Array.isArray(entry.items) && entry.items.length > 0 && (
            <ul className="ext-ephemeral-list">
              {entry.items.map((it, i) => (
                <li key={i}>
                  <code>{String(it?.label ?? '')}</code>
                  {it?.detail ? <span className="muted"> {String(it.detail)}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {Array.isArray(entry.items) && entry.items.length === 0 && <p className="ext-ephemeral-text muted">Nothing to show here.</p>}
          {typeof entry.render === 'function' && <ExtRender fn={entry.render} label={entry.title} notice />}
        </section>
      ))}
    </div>
  );
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}
