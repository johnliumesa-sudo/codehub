// Workstream: assistant. A personal Claude assistant that uses each user's own Anthropic API key,
// straight from their browser (no server). Registers: Settings → Assistant, the Assistant chat panel
// (+ header button, palette action, sidebar toggle and Ctrl/⌘+Shift+Y), Catch me up (header button,
// palette action, panel), message actions (Explain code, Translate, Summarize thread), the composer's
// writing help, /ask, inline translations and the "AI" badge on shared answers.
// See docs/features/assistant.md.
import { createElement as h } from 'react';
import { register } from '../../lib/ext/registry.js';
import { onLock } from '../../lib/keystore.js';
import { getSession, chatCtx, resetSession } from './lib/session.js';
import { hasCode, inThread, isReadable } from './lib/prompts.js';
import {
  PANEL_ID, askPrivately, catchUp, explainCode, stopAll, summarizeThread, togglePanel, translate,
} from './lib/actions.js';
import AssistantPanel from './components/AssistantPanel.jsx';
import AssistantSettings from './components/SettingsTab.jsx';
import ComposerTools from './components/ComposerTools.jsx';
import { AiBadge, TranslationExtra, sharedAnswerInfo } from './components/MessageBits.jsx';
import { AssistantMount, SidebarToggle } from './components/WorkspaceBits.jsx';

const hasText = (m) => isReadable(m) && typeof m.body.text === 'string' && !!m.body.text.trim();

register('userSettingsTabs', { id: 'assistant', label: 'Assistant', render: (ctx) => h(AssistantSettings, { ctx }) });

register('chatPanels', { id: PANEL_ID, title: 'Assistant', render: (ctx) => h(AssistantPanel, { ctx }) });
register('chatHeaderButtons', { id: 'assistant.panel', label: 'Assistant', icon: '✨', panel: PANEL_ID });
register('chatHeaderButtons', { id: 'assistant.catchup', label: 'Catch me up', icon: '⚡', run: (ctx) => catchUp(ctx, 'unread') });

register('paletteActions', {
  id: 'assistant.toggle',
  title: 'Toggle assistant panel',
  hint: 'Claude with your own API key · Ctrl/⌘+Shift+Y',
  keywords: ['claude', 'ai', 'assistant', 'chat'],
  run: (ws) => {
    if (!togglePanel()) ws.toast('Open a conversation to see the assistant panel.', 'info');
  },
});
register('paletteActions', {
  id: 'assistant.catchup',
  title: 'Catch me up on this conversation',
  hint: 'Claude summarizes what you missed',
  keywords: ['claude', 'ai', 'summary', 'unread', 'summarize'],
  run: () => {
    const ctx = chatCtx();
    if (!ctx) throw new Error('Open a conversation first.');
    return catchUp(ctx, 'unread');
  },
});
register('paletteActions', {
  id: 'assistant.settings',
  title: 'Assistant settings',
  hint: 'API key, model and effort',
  keywords: ['claude', 'ai', 'api key', 'anthropic'],
  run: (ws) => ws.openSettings('assistant'),
});

register('messageActions', { id: 'assistant.explain', label: 'Explain code', icon: '🧠', when: (m) => hasCode(m), run: (m, ctx) => explainCode(m, ctx) });
register('messageActions', { id: 'assistant.translate', label: 'Translate', icon: '🌐', when: hasText, run: (m, ctx) => translate(m, ctx) });
register('messageActions', {
  id: 'assistant.thread',
  label: 'Summarize thread',
  icon: '🧵',
  when: (m, ctx) => isReadable(m) && inThread(m, ctx.messages),
  run: (m, ctx) => summarizeThread(m, ctx),
});
register('messageExtras', { id: 'assistant.translation', render: (m, ctx) => h(TranslationExtra, { m, ctx }) });
register('messageBadges', {
  id: 'assistant.ai',
  render: (m) => (sharedAnswerInfo(m) ? h(AiBadge, { m }) : null),
  groupKey: (m) => (sharedAnswerInfo(m) ? 'ai' : ''), // a shared answer starts its own header, so the badge shows
});

register('composerButtons', { id: 'assistant.write', render: (ctx) => h(ComposerTools, { ctx }) });

register('slashCommands', {
  name: 'ask',
  description: 'Ask Claude privately; the answer shows only in your assistant panel',
  args: '<question>',
  run: (args, ctx) => {
    if (!args) return { cancel: true, reason: 'Type a question after /ask.' };
    if (getSession().turns.some((t) => t.status === 'streaming')) return { cancel: true, reason: 'Wait for the current assistant reply to finish.' };
    askPrivately(args, ctx).catch((e) => ctx.toast(e?.message || 'Could not ask Claude'));
    return { handled: true };
  },
});

register('sidebarSections', { id: 'assistant.toggle', render: (ctx) => h(SidebarToggle, { ctx }) });
register('appMounts', { id: 'assistant', Component: AssistantMount });

// Locking the vault (or signing out) drops the unlocked key, the conversation and translations.
onLock(() => {
  stopAll();
  resetSession();
});
