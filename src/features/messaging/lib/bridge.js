// The open chat, seen from outside ChatView. ChatBridge (a composerButtons render entry, so it lives
// inside the ChatView's ChatContext) publishes the current ChatContext here; workspace-level code
// (message links, reminders, palette actions) uses it to jump to a message or open a chat panel.
// Plain module state: no React, no Firebase.
import { sameConv } from './links.js';

let current = null;
const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(current);
    } catch {
      /* ignore */
    }
  }
}

/** ChatBridge: the chat ctx is (still) mounted with this value. */
export function publishChat(ctx) {
  current = ctx || null;
  emit();
}

/** ChatBridge unmounted: forget it unless a newer chat already took over. */
export function retractChat(ctx) {
  if (current === ctx) {
    current = null;
    emit();
  }
}

export const currentChat = () => current;

export function subscribeChat(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Resolves with the first published chat ctx that satisfies `test` (checked immediately and on every
 * change), or null after `timeout` ms.
 */
export function waitForChat(test, timeout = 10_000) {
  return new Promise((resolve) => {
    let done = false;
    let off = () => {};
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(v);
    };
    const check = (ctx) => {
      try {
        if (ctx && test(ctx)) finish(ctx);
      } catch {
        /* keep waiting */
      }
    };
    const timer = setTimeout(() => finish(null), timeout);
    off = subscribeChat(check);
    check(current);
  });
}

/** The open chat's ctx if it shows `conv`. */
export const chatFor = (conv) => (current && sameConv(current.conv, conv) ? current : null);
