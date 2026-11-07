// Round 3: the chat-level extension context. ChatView provides it; every chat extension point
// (messageActions, messageBadges, messageExtras, composerButtons, chatHeaderButtons, chatPanels,
// slashCommands, sendHooks) receives its value as `ctx`. Fields (documented in ARCHITECTURE.md):
//   conv        { kind: 'channel'|'dm'|'group', sid?, cid?, dmId?, peerUid?, gid?, epoch?, name, scope }
//   me          { uid, name, color, ...profile }
//   perms       permsFor() map in a server channel ({ staff, manageMessages, manageApps, ... }), else null
//   members     { [uid]: member record } of the server / group (DM: both participants)
//   messages    loaded messages in order: { mid, uid, ts, body?, error?, pending?, deleted?, sending?,
//               reactions?, pinned?, replyTo?, editedAt? } (body = decrypted JSON incl. extension keys)
//   profiles    { [uid]: profile } for members and authors
//   canSend     the composer is usable (key loaded, not timed out, not blocked)
//   hasMore     older messages exist; loadOlder() loads the next page
//   send(draft) run the send pipeline (sendHooks, then encrypt + write); resolves true when sent/handled
//   insertText(text)  insert at the composer caret and focus it
//   jumpTo(mid) scroll to + highlight a message, paging older history in; toasts when not found
//   reply(mid)  start a reply to a message
//   openPanel(id) / closePanel() / panel   the right-side chat panel (chatPanels id, or null)
//   toast(text, kind?)  transient notice ('error' default, or 'ok')
//   ephemeral({ id?, title?, text?, items?: [{label, detail?}], render?: () => node }) -> dismiss()
//               a local-only card above the composer ("Only you can see this")
import { createContext, useContext } from 'react';

export const ChatContext = createContext(null);

/** The current chat ctx, or null outside a ChatView. */
export function useChatCtx() {
  return useContext(ChatContext);
}
