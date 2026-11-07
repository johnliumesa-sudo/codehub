// The open chat, seen from the rest of the app. Two pieces:
//  1. ChatPublisher (a chatMounts entry: mounted for as long as the ChatView is open, also while its
//     composer is hidden by a timeout, a block or a missing key) publishes the ChatContext for
//     workspace-level code (bridge.js: message links, reminders, palette), so a link can always jump;
//  2. ChatBridge (a composerButtons render entry, so it lives exactly as long as the composer): drafts.
//     Restores this conversation's unsent text on open and keeps it saved while typing (localStorage
//     only, sealed; cleared once the composer is empty again, e.g. after sending).
import { useEffect, useRef } from 'react';
import { publishChat, retractChat } from '../lib/bridge.js';
import { drafts } from '../lib/drafts.js';
import { convKey } from '../lib/links.js';

export const DRAFT_SAVE_DELAY = 400;
const POLL_MS = 1000;

export function convTitle(conv) {
  const name = String(conv?.name || conv?.title || '').trim();
  if (conv?.kind === 'channel') return name ? `#${name}` : 'a channel';
  if (conv?.kind === 'dm') return name ? `@${name}` : 'a direct message';
  return name || 'a group';
}

/** chatMounts entry: keeps bridge.js pointing at this chat's current ChatContext while it is open. */
export function ChatPublisher({ ctx }) {
  const published = useRef(null);
  useEffect(() => {
    published.current = ctx;
    publishChat(ctx);
  }, [ctx]);
  useEffect(() => () => retractChat(published.current), []);
  return null;
}

/** composerButtons entry: this conversation's draft (draws nothing visible). */
export default function ChatBridge({ ctx }) {
  const anchor = useRef(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const uid = ctx?.me?.uid || null;
  const key = convKey(ctx?.conv);
  useEffect(() => {
    const el = anchor.current?.closest('.composer')?.querySelector('textarea.composer-input');
    if (!el || !uid || !key) return undefined;
    const conv = ctxRef.current.conv;
    let alive = true;
    let ready = false;
    let last = null;
    let timer = null;

    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (!ready) return;
      const v = el.value;
      if (v === last) return;
      last = v;
      drafts.save(uid, conv, v, convTitle(ctxRef.current?.conv || conv)).catch(() => {});
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, DRAFT_SAVE_DELAY);
    };

    drafts.get(uid, conv).then((d) => {
      if (!alive) return;
      if (d?.text && !el.value) {
        last = d.text;
        ctxRef.current?.insertText?.(d.text);
      } else {
        last = d?.text ?? '';
      }
      ready = true;
      if (el.value !== last) schedule();
    }, () => {
      ready = true;
    });

    const onInput = () => schedule();
    // Programmatic changes (send clears the box, completions, ctx.insertText) fire no input event.
    const poll = setInterval(() => {
      if (ready && el.value !== last) schedule();
    }, POLL_MS);
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    el.addEventListener('input', onInput);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      alive = false;
      clearInterval(poll);
      el.removeEventListener('input', onInput);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush(); // the (now detached) textarea still holds its last value
    };
  }, [uid, key]);

  return <span ref={anchor} hidden data-mx-bridge="" />;
}
