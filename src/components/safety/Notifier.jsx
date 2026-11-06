import { useBlocks } from '../../lib/blocks.js';
import { useNotifPrefs, useNotifier } from '../../lib/notify.js';

/**
 * Invisible: mount once in Workspace (F19). Watches the newest message of every source, decrypts it
 * locally, and raises a desktop notification + "(n)" page-title prefix according to the user's prefs
 * and mutes. Messages from blocked users never notify.
 * Props:
 *  - me: { uid, name } (required)
 *  - sources: [{ scope, path?, conv, title, serverName? }] (see useNotifySources in lib/notify.js)
 *  - activeScope: scope of the conversation on screen, or null
 *  - reads: reads/{uid} map (scope -> ts)
 *  - onOpen(source): navigate when a notification is clicked
 */
export default function Notifier({ me, sources, activeScope = null, reads, onOpen }) {
  const prefs = useNotifPrefs(me?.uid);
  const blocked = useBlocks(me?.uid);
  useNotifier({ me, sources, activeScope, prefs, reads, blocked, onOpen });
  return null;
}
