// Mounted (invisibly) in the composer of the open conversation, as a composerButtons render entry:
// - registers the slash commands of the bots installed in this server (removed again on unmount);
// - sends queued keyword-trigger replies once their original message shows up;
// - posts a new member's welcome messages (once per bot, claimed in udata);
// - renders the poll creator / GIF picker that /poll and /gif ask for.
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { onValue, ref } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { register } from '../../../lib/ext/registry.js';
import { renderMarkdown } from '../../../lib/markdown.js';
import PollComposer from '../../../components/chatx/PollComposer.jsx';
import { GifPicker } from '../../../components/media/GifPicker.jsx';
import { BOT_LIMITS } from '../lib/schema.js';
import { claimWelcome, firstTextChannel, peekInstalled, useInstalledBots, welcomeDone } from '../lib/store.js';
import { commandDraft, slowmodes, welcomeDraft } from '../lib/runtime.js';
import { onPending, takeReady } from '../lib/pending.js';
import { closeTool, useTool } from '../lib/toolbus.js';

export default function BotsHost({ ctx }) {
  const conv = ctx.conv;
  const sid = conv.kind === 'channel' ? conv.sid : null;
  const installed = useInstalledBots(sid);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useBotCommands(sid, installed);
  useSlowmode(sid, conv.kind === 'channel' ? conv.cid : null, conv.scope);
  useTriggerReplies(ctx, ctxRef);
  useWelcome(ctx, ctxRef, installed);

  return <ComposerTools ctx={ctx} ctxRef={ctxRef} />;
}

/** Slash commands of the installed bots, offered in this server's channels while the composer is open. */
function useBotCommands(sid, installed) {
  useEffect(() => {
    if (!sid || !installed?.length) return undefined;
    const offs = [];
    let order = 100;
    for (const bot of installed) {
      for (const cmd of bot.def.commands) {
        offs.push(register('slashCommands', {
          id: `bots:${sid}:${bot.id}:${cmd.name}`,
          name: cmd.name,
          args: cmd.usage || undefined,
          description: `${cmd.desc || 'Bot command'} · ${bot.def.name} (bot)`,
          scopes: ['channel'],
          group: 'bot',
          order: order++,
          async run(args, ctx) {
            if (ctx?.conv?.kind !== 'channel' || ctx.conv.sid !== sid) return { cancel: true, reason: `/${cmd.name} only works in this bot's server.` };
            const cur = peekInstalled(sid).find((b) => b.id === bot.id);
            const c = cur?.def.commands.find((x) => x.name === cmd.name);
            if (!cur || !c) return { cancel: true, reason: `${bot.def.name} no longer has /${cmd.name}.` };
            return commandDraft(cur, c, args, ctx);
          },
        }));
      }
    }
    return () => offs.forEach((off) => off());
  }, [sid, installed]);
}

/** Keeps the channel's slowmode in `slowmodes` (trigger replies are skipped where they'd be refused). */
function useSlowmode(sid, cid, scope) {
  useEffect(() => {
    if (!sid || !cid) return undefined;
    const off = onValue(
      ref(db, `servers/${sid}/channels/${cid}/slowmode`),
      (s) => slowmodes.set(scope, typeof s.val() === 'number' ? s.val() : 0),
      () => slowmodes.delete(scope),
    );
    return () => {
      off();
      slowmodes.delete(scope);
    };
  }, [sid, cid, scope]);
}

/** Sends queued trigger replies after their original message appears (in order, one at a time). */
function useTriggerReplies(ctx, ctxRef) {
  const busy = useRef(false);
  const flush = useRef(null);
  flush.current = async () => {
    if (busy.current) return;
    const c = ctxRef.current;
    if (c.conv.kind !== 'channel' || !c.canSend) return;
    const ready = takeReady(c.conv.scope, c.me?.uid, c.messages);
    if (!ready.length) return;
    busy.current = true;
    try {
      for (const p of ready) await ctxRef.current.send(p.draft);
    } finally {
      busy.current = false;
    }
  };
  useEffect(() => {
    flush.current();
  }, [ctx.messages, ctx.canSend]);
  useEffect(() => onPending(() => flush.current()), []);
}

/** A new member's welcome messages, posted from their own browser on their first visit to the first text channel. */
function useWelcome(ctx, ctxRef, installed) {
  const tried = useRef(new Set());
  const conv = ctx.conv;
  const uid = ctx.me?.uid;
  const joinedAt = conv.kind === 'channel' ? ctx.members?.[uid]?.joinedAt : undefined;
  const canSend = ctx.canSend;
  useEffect(() => {
    if (conv.kind !== 'channel' || !installed?.length || !canSend || typeof joinedAt !== 'number') return;
    const due = installed.filter((b) => b.def.welcome && b.at > 0 && joinedAt >= b.at && !tried.current.has(b.id));
    if (!due.length) return;
    due.forEach((b) => tried.current.add(b.id));
    (async () => {
      try {
        if ((await firstTextChannel(conv.sid)) !== conv.cid) return;
        let posted = 0;
        for (const bot of due) {
          if (await welcomeDone(conv.sid, bot.id)) continue;
          if (!(await claimWelcome(conv.sid, bot.id))) continue;
          if (posted >= BOT_LIMITS.welcomesPerJoin) continue; // claimed: never posted later either
          const c = ctxRef.current;
          const draft = await welcomeDraft(bot, c);
          if (!draft) continue;
          posted++;
          if ((slowmodes.get(conv.scope) || 0) > 0 && !c.perms?.manageMessages) {
            // A post now would start my slowmode wait: show it to me only.
            c.ephemeral({ id: `bots.welcome.${bot.id}`, title: `${bot.def.name} (bot)`, render: () => <WelcomeCard text={draft.text} /> });
          } else {
            await c.send(draft);
          }
        }
      } catch (e) {
        console.warn('[bots] welcome message failed', e);
      }
    })();
  }, [conv.kind, conv.sid, conv.cid, conv.scope, installed, canSend, joinedAt, ctxRef]);
}

function WelcomeCard({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // Sanitized by DOMPurify in renderMarkdown().
  return <div className="md bt-welcome-card" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The poll creator and GIF picker requested by /poll and /gif for this conversation. */
function ComposerTools({ ctx, ctxRef }) {
  const tool = useTool();
  const mine = tool && tool.scope === ctx.conv.scope ? tool : null;
  const boxRef = useRef(null);

  useEffect(() => {
    if (!mine || mine.kind !== 'gif') return undefined;
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) closeTool(mine.seq);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [mine]);
  // Leaving the conversation closes its tool.
  useEffect(() => () => closeTool(), []);

  if (!mine) return null;
  if (mine.kind === 'poll') {
    return createPortal(
      <PollComposer
        onClose={() => closeTool(mine.seq)}
        onCreate={async (poll) => {
          const ok = await ctxRef.current.send({ text: '', poll, extra: { cmd: 'poll' } });
          if (!ok) throw new Error('The poll could not be posted.');
        }}
      />,
      document.body,
    );
  }
  if (mine.kind === 'gif') {
    return (
      <div ref={boxRef} className="bt-gif-pop">
        <div className="bt-gif-head">
          <span>GIFs for <q>{mine.query || 'trending'}</q></span>
          <button type="button" className="bt-icon-btn" onClick={() => closeTool(mine.seq)} aria-label="Close GIF picker">✕</button>
        </div>
        <GifPicker
          initialQuery={mine.query}
          onClose={() => closeTool(mine.seq)}
          onPick={async (g) => {
            closeTool(mine.seq);
            if (g?.url) await ctxRef.current.send({ text: '', gif: g, extra: { cmd: 'gif' } });
          }}
        />
      </div>
    );
  }
  return null;
}
