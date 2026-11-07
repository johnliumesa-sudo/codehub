// /poll and /gif open the existing poll creator and GIF picker. Commands run outside React, so they
// post a request here and the composer host (BotsHost, mounted in the composer of the open
// conversation) renders the tool for that conversation's scope.
import { useSyncExternalStore } from 'react';

let current = null; // { scope, kind: 'poll' | 'gif', query?, seq }
let seq = 0;
const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

/** Ask the composer of conversation `scope` to open a tool. */
export function openTool(scope, kind, extra = {}) {
  current = { scope: String(scope || ''), kind, ...extra, seq: ++seq };
  emit();
}

/** Close the tool (only if it is still the one identified by `seqNo`, when given). */
export function closeTool(seqNo) {
  if (!current || (seqNo !== undefined && current.seq !== seqNo)) return;
  current = null;
  emit();
}

export function peekTool() {
  return current;
}

/** React: the open tool request, or null. */
export function useTool() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => current,
  );
}
