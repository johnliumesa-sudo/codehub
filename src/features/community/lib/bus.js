// UI requests between community extension points (slash command -> editor modal, sidebar -> chat
// panel, composer -> welcome modal, server-create choice -> discover view). One small external store;
// the modals live in CommunityHost (an appMount) so they work from anywhere in the workspace.
import { useSyncExternalStore } from 'react';

let state = Object.freeze({ editor: null, welcome: null, discover: false, panel: null, detail: null });
const fns = new Set();

function set(patch) {
  state = Object.freeze({ ...state, ...patch });
  fns.forEach((f) => f());
}

export const getUi = () => state;
export function useUi() {
  return useSyncExternalStore((f) => { fns.add(f); return () => fns.delete(f); }, getUi, getUi);
}

/** Open the event editor: { sid, event? (to edit), title?, conv?, send? (ChatContext send, to announce) }. */
export const openEventEditor = (req) => set({ editor: { ...req, at: Date.now() } });
export const closeEventEditor = () => set({ editor: null });

/** Show one event's details in a modal: { sid, id }. */
export const openEventDetail = (req) => set({ detail: req });
export const closeEventDetail = () => set({ detail: null });

/** Show a server's welcome screen even if already seen: sid. */
export const openWelcome = (sid) => set({ welcome: { sid, at: Date.now() } });
export const closeWelcome = () => set({ welcome: null });

export const openDiscover = () => set({ discover: true });
export const closeDiscover = () => set({ discover: false });

/** Ask the chat view of `sid` to open the events panel (consumed by the in-chat bridge). */
export const requestEventsPanel = (sid) => set({ panel: { sid, at: Date.now() } });
export const consumePanelRequest = () => set({ panel: null });
