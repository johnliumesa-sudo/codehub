// Workstream: messaging (voice messages, reminders, message links, run code snippets, chat export,
// drafts). Everything is registered through the extension registries; see docs/features/messaging.md.
import { createElement as h } from 'react';
import { register } from '../../lib/ext/registry.js';
import { copyText } from '../../components/layout/ui.jsx';
import { currentChat } from './lib/bridge.js';
import { buildMessageLink, convRef } from './lib/links.js';
import { parseWhen, formatDue } from './lib/when.js';
import { excerptOf } from './lib/reminderModel.js';
import { createReminder } from './lib/reminders.js';
import ChatBridge, { convTitle } from './components/ChatBridge.jsx';
import { VoiceButton } from './components/Voice.jsx';
import { RemindDialogHost, openRemindDialog } from './components/RemindDialog.jsx';
import { ReminderScheduler, RemindersPanel } from './components/Reminders.jsx';
import { LinkChips, LinkRouter } from './components/Links.jsx';
import { runCodeExtra } from './components/RunCode.jsx';
import { ExportPanel } from './components/ExportPanel.jsx';
import { draftsSection } from './components/DraftsSection.jsx';
import { AlarmIcon, DownloadIcon, LinkIcon } from './components/icons.jsx';
import './messaging.css';

export const PANEL_REMINDERS = 'messaging.reminders';
export const PANEL_EXPORT = 'messaging.export';

const sent = (m) => !!m && !m.deleted && !m.error && !m.pending && !m.sending && typeof m.ts === 'number' && !!m.body;

// ---------- composer: chat bridge + drafts (invisible), voice messages ----------
register('composerButtons', { id: 'messaging.bridge', order: -1000, render: (ctx) => h(ChatBridge, { ctx }) });
register('composerButtons', { id: 'messaging.voice', render: (ctx) => h(VoiceButton, { ctx }) });

// ---------- message actions ----------
register('messageActions', {
  id: 'messaging.copyLink',
  label: 'Copy link',
  icon: h(LinkIcon),
  when: (m) => sent(m),
  async run(m, ctx) {
    const link = buildMessageLink(ctx.conv, m.mid);
    if (!link) throw new Error('This message has no link');
    const ok = await copyText(link);
    ctx.toast(ok ? 'Message link copied' : 'Couldn’t copy the link', ok ? 'ok' : 'error');
  },
});
register('messageActions', {
  id: 'messaging.remind',
  label: 'Remind me…',
  icon: h(AlarmIcon, { size: 16 }),
  when: (m) => sent(m),
  run(m, ctx) {
    openRemindDialog({
      conv: convRef(ctx.conv),
      mid: m.mid,
      title: convTitle(ctx.conv),
      excerpt: excerptOf(m.body),
      author: ctx.profiles?.[m.uid]?.name || '',
      toast: ctx.toast,
    });
  },
});

// ---------- message extras: link chips, run code ----------
register('messageExtras', { id: 'messaging.links', render: (m, ctx) => (m?.body?.text?.includes?.('#/m/') ? h(LinkChips, { m, ctx }) : null) });
register('messageExtras', { id: 'messaging.run', render: (m) => runCodeExtra(m) });

// ---------- /remind ----------
const REMIND_USAGE = 'Usage: /remind <when> <what>, e.g. /remind 20m stretch · /remind tomorrow 9:00 standup · /remind fri 15:00 demo';
register('slashCommands', {
  name: 'remind',
  description: 'Set a private reminder for this conversation',
  args: '<when> <what>',
  async run(args, ctx) {
    const w = parseWhen(args);
    if (!w) return { cancel: true, reason: REMIND_USAGE };
    await createReminder({ due: w.due, note: w.rest, conv: ctx.conv, title: convTitle(ctx.conv) });
    ctx.ephemeral({
      id: 'messaging.remind',
      title: 'Reminder set',
      text: `I’ll remind you ${formatDue(w.due)}${w.rest ? `: ${w.rest}` : ''}. Only you can see reminders.`,
    });
    return { handled: true };
  },
});

// ---------- panels + header buttons ----------
register('chatPanels', { id: PANEL_REMINDERS, title: 'Reminders', render: (ctx) => h(RemindersPanel, { ctx }) });
register('chatPanels', { id: PANEL_EXPORT, title: 'Export chat', render: (ctx) => h(ExportPanel, { ctx }) });
register('chatHeaderButtons', { id: 'messaging.reminders', label: 'Reminders', icon: h(AlarmIcon), panel: PANEL_REMINDERS });
register('chatHeaderButtons', { id: 'messaging.export', label: 'Export chat', icon: h(DownloadIcon), panel: PANEL_EXPORT });

// ---------- command palette ----------
const openPanelAction = (panel, what) => (ctx) => {
  const chat = currentChat();
  if (!chat) {
    ctx.toast(`Open a conversation to see ${what}.`, 'info');
    return;
  }
  chat.openPanel(panel);
};
register('paletteActions', { id: 'messaging.reminders', title: 'Show reminders', hint: 'Messaging', keywords: ['remind', 'reminder', 'snooze'], run: openPanelAction(PANEL_REMINDERS, 'your reminders') });
register('paletteActions', { id: 'messaging.export', title: 'Export this conversation', hint: 'Markdown or JSON', keywords: ['export', 'download', 'backup', 'markdown', 'json'], when: () => !!currentChat(), run: openPanelAction(PANEL_EXPORT, 'the export options') });

// ---------- workspace: link routing, reminder scheduler, remind dialog, drafts sidebar ----------
register('appMounts', { id: 'messaging.links', Component: LinkRouter });
register('appMounts', { id: 'messaging.reminders', Component: ReminderScheduler });
register('appMounts', { id: 'messaging.remindDialog', Component: RemindDialogHost });
register('sidebarSections', { id: 'messaging.drafts', render: (ctx) => draftsSection(ctx) });
