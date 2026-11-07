// Open a message (or just a conversation) from anywhere: message links, link chips, reminders.
// Checks that I can see the conversation, navigates there through the WorkspaceContext, waits for the
// chat to mount (bridge.js) and calls its jumpTo(mid), which pages older history in, highlights the
// message, or says it's no longer available.
import { get, ref } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { convRef, dmPeerOf, sameConv } from './links.js';
import { chatFor, waitForChat } from './bridge.js';

let workspace = null; // WorkspaceContext, set by LinkRouter (appMounts)

export function setWorkspace(ctx) {
  workspace = ctx || null;
}
export const getWorkspace = () => workspace;

/** null when I can open the conversation, else a reason to show. */
export async function accessProblem(conv, ws = workspace) {
  const uid = ws?.me?.uid;
  if (!uid) return 'You need to be signed in.';
  if (conv.kind === 'channel') {
    // Reading the channel needs membership of the server (the rules deny everyone else).
    try {
      const ch = await get(ref(db, `servers/${conv.sid}/channels/${conv.cid}`));
      if (!ch.exists()) return 'That channel no longer exists.';
      const type = ch.val()?.type;
      if (type === 'code' || type === 'voice') return 'That link doesn’t point to a text channel.';
    } catch {
      return 'You don’t have access to that message: you’re not in that server.';
    }
    return null;
  }
  if (conv.kind === 'dm') {
    return dmPeerOf(conv.dmId, uid) ? null : 'You don’t have access to that message: it’s in someone else’s direct messages.';
  }
  if (conv.kind === 'group') {
    try {
      const s = await get(ref(db, `userGroups/${uid}/${conv.gid}`));
      return s.exists() ? null : 'You don’t have access to that message: you’re not in that group.';
    } catch {
      return 'You don’t have access to that group.';
    }
  }
  return 'That link isn’t valid.';
}

/**
 * Navigate to `target` ({ kind, sid?, cid?, dmId?, gid?, mid? }) and jump to its message.
 * Resolves true when the conversation opened (the chat itself reports a missing message).
 */
export async function openTarget(target, { ws = workspace, toast } = {}) {
  const say = (text) => (toast ? toast(text) : ws?.toast?.(text, 'error'));
  const conv = convRef(target);
  if (!conv || !ws) {
    say('That link isn’t valid.');
    return false;
  }
  const problem = await accessProblem(conv, ws);
  if (problem) {
    say(problem);
    return false;
  }
  if (!chatFor(conv)) ws.openConv(conv);
  if (!target.mid) return true;
  // Wait for that chat to mount and its first page of messages to arrive.
  const ready = await waitForChat((c) => sameConv(c.conv, conv) && c.messages.length > 0, 8000);
  const ctx = ready || chatFor(conv);
  if (!ctx) {
    // The conversation is open but its chat can't take a jump right now (e.g. still loading, or a
    // timeout hides the composer the bridge lives in).
    say('Opened the conversation, but couldn’t scroll to the message.');
    return false;
  }
  ctx.jumpTo(target.mid);
  return true;
}
