// Chat export (pure): decrypted messages -> plain records -> Markdown or JSON text. The exporter
// (exporter.js) fetches and decrypts; this module only formats, so it is unit-tested directly.
// Message bodies are untrusted input: every field is type-checked and turned into plain text.
import { cleanAudioAtt, formatDuration } from '../../../lib/media/audio.js';
import { emojiFromKey } from '../../../lib/reactions.js';

export const EXPORT_FORMAT = 'codehub-chat-export';
export const EXPORT_VERSION = 1;

const str = (v, max = 100_000) => (typeof v === 'string' ? v.slice(0, max) : '');
const iso = (ts) => (Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null);

/**
 * One export record from a raw message ({ mid, uid, ts, deleted?, editedAt?, replyTo?, pinned?,
 * reactions? }) and its decrypted body (or an error). `names` maps uid -> display name.
 */
export function toRecord(raw, body, names = {}, error = null) {
  const rec = {
    id: String(raw?.mid || ''),
    ts: Number.isFinite(raw?.ts) ? raw.ts : null,
    time: iso(raw?.ts),
    author: { uid: str(raw?.uid, 128), name: str(names[raw?.uid], 200) || 'Unknown' },
  };
  if (raw?.deleted) return { ...rec, deleted: true };
  if (error || !body || typeof body !== 'object') return { ...rec, undecryptable: true };
  rec.text = str(body.text);
  if (body.code && typeof body.code === 'object' && typeof body.code.content === 'string') {
    rec.code = { lang: str(body.code.lang, 40) || 'plaintext', content: body.code.content };
    if (typeof body.code.filename === 'string' && body.code.filename) rec.code.filename = str(body.code.filename, 200);
  }
  if (Array.isArray(body.attachments)) {
    const atts = [];
    for (const a of body.attachments.slice(0, 8)) {
      if (!a || typeof a !== 'object') continue;
      if (a.kind === 'audio') {
        const v = cleanAudioAtt(a);
        if (v) atts.push({ type: 'voice', mime: v.mime, size: v.size, duration: v.dur });
      } else if (typeof a.mime === 'string' && a.mime.startsWith('image/')) {
        atts.push({ type: 'image', mime: str(a.mime, 40), size: Number(a.size) || 0, width: Number(a.w) || 0, height: Number(a.h) || 0 });
      }
    }
    if (atts.length) rec.attachments = atts;
  }
  if (body.gif && typeof body.gif === 'object' && typeof body.gif.url === 'string') rec.gif = str(body.gif.url, 2000);
  if (body.poll && typeof body.poll === 'object' && typeof body.poll.q === 'string') {
    rec.poll = { question: str(body.poll.q, 500), options: Array.isArray(body.poll.options) ? body.poll.options.slice(0, 10).map((o) => str(o, 200)) : [] };
  }
  if (body.fwd && typeof body.fwd === 'object' && typeof body.fwd.from === 'string') rec.forwardedFrom = str(body.fwd.from, 64);
  if (typeof raw.replyTo === 'string') rec.replyTo = raw.replyTo;
  if (Number.isFinite(raw.editedAt)) rec.editedAt = iso(raw.editedAt);
  if (raw.pinned === true) rec.pinned = true;
  if (raw.reactions && typeof raw.reactions === 'object') {
    const r = {};
    for (const [k, who] of Object.entries(raw.reactions)) {
      const n = who && typeof who === 'object' ? Object.keys(who).length : 0;
      if (n) r[k] = n;
    }
    if (Object.keys(r).length) rec.reactions = r;
  }
  return rec;
}

/** JSON text of an export. `meta` = { title, kind, exportedAt, exportedBy, range: { from?, to? } }. */
export function toJson(records, meta = {}) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    note: 'Decrypted copy of an end-to-end encrypted conversation. This file is NOT encrypted.',
    conversation: { kind: meta.kind || null, title: meta.title || '' },
    exportedAt: iso(meta.exportedAt ?? Date.now()),
    exportedBy: meta.exportedBy || null,
    range: { from: iso(meta.range?.from), to: iso(meta.range?.to) },
    count: records.length,
    messages: records,
  }, null, 2);
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Markdown-safe single-line text (names, titles). */
export function mdInline(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#|~])/g, '\\$1');
}

/** A fence long enough for content that itself contains backticks. */
export function fence(content) {
  const runs = String(content).match(/`+/g) || [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Markdown text of an export (one heading per local day, one entry per message). */
export function toMarkdown(records, meta = {}) {
  const lines = [];
  const title = meta.title ? mdInline(meta.title) : 'conversation';
  lines.push(`# Chat export: ${title}`, '');
  const when = new Date(meta.exportedAt ?? Date.now());
  lines.push(`Exported ${localDay(when.getTime())} ${localTime(when.getTime())}${meta.exportedBy ? ` by ${mdInline(meta.exportedBy)}` : ''} from Codehub · ${records.length} message${records.length === 1 ? '' : 's'}`);
  if (meta.range?.from || meta.range?.to) {
    lines.push(`Range: ${meta.range.from ? localDay(meta.range.from) : 'beginning'} to ${meta.range.to ? localDay(meta.range.to) : 'now'}`);
  }
  lines.push('', '> This file is a decrypted copy of an end-to-end encrypted conversation. It is not encrypted.', '');
  let day = null;
  for (const r of records) {
    if (r.ts) {
      const d = localDay(r.ts);
      if (d !== day) {
        day = d;
        lines.push(`## ${d}`, '');
      }
    }
    const head = `**${mdInline(r.author?.name || 'Unknown')}** · ${r.ts ? localTime(r.ts) : '--:--'}${r.editedAt ? ' (edited)' : ''}${r.pinned ? ' 📌' : ''}`;
    lines.push(head);
    if (r.deleted) lines.push('_Message deleted_');
    else if (r.undecryptable) lines.push('_Unable to decrypt this message_');
    else {
      if (r.forwardedFrom) lines.push(`_Forwarded from ${mdInline(r.forwardedFrom)}_`);
      if (r.replyTo) lines.push(`_Reply to message ${r.replyTo}_`);
      if (r.text) lines.push(r.text);
      if (r.code) {
        const f = fence(r.code.content);
        if (r.code.filename) lines.push(`\`${r.code.filename.replace(/`/g, "'")}\``);
        lines.push(`${f}${r.code.lang === 'plaintext' ? '' : r.code.lang}`, r.code.content, f);
      }
      for (const a of r.attachments || []) {
        if (a.type === 'voice') lines.push(`_[voice message, ${formatDuration(a.duration)}]_`);
        else lines.push(`_[image ${a.width}×${a.height}, ${a.mime}]_`);
      }
      if (r.gif) lines.push(`_[GIF: ${r.gif}]_`);
      if (r.poll) {
        lines.push(`_Poll:_ ${mdInline(r.poll.question)}`);
        for (const o of r.poll.options) lines.push(`- ${mdInline(o)}`);
      }
    }
    if (r.reactions) lines.push(`Reactions: ${Object.entries(r.reactions).map(([k, n]) => `${emojiFromKey(k)} ${n}`).join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** "codehub-general-2026-11-06.md" (title reduced to safe characters). */
export function exportFilename(title, ext, now = Date.now()) {
  const slug = String(title || 'conversation')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 40) || 'conversation';
  return `codehub-${slug}-${localDay(now)}.${ext}`;
}
