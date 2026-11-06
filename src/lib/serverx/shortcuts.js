// Keyboard shortcut catalogue shown by the "?" overlay. Keep in sync with real bindings.
export const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
export const MOD = isMac ? '⌘' : 'Ctrl';

export const SHORTCUT_GROUPS = [
  {
    title: 'General',
    items: [
      { keys: ['?'], label: 'Show this overlay' },
      { keys: [MOD, 'K'], label: 'Open the command palette' },
      { keys: ['Esc'], label: 'Close dialogs and menus' },
    ],
  },
  {
    title: 'Chat',
    items: [
      { keys: ['Enter'], label: 'Send message' },
      { keys: ['Shift', 'Enter'], label: 'New line' },
      { keys: ['↑'], label: 'Edit your last message (empty composer)' },
      { keys: [':'], label: 'Emoji and emote autocomplete' },
      { keys: ['@'], label: 'Mention someone' },
    ],
  },
];

/** True when the keydown should be ignored because the user is typing somewhere. */
export function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.closest?.('.cm-editor');
}

export const isHelpKey = (e) => e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey;
