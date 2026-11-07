// Call health: pure logic with no browser or Firebase imports (unit-tested in tests/unit/calls.test.mjs).
//
//  - Slot liveness from the heartbeat (`hb`, a server timestamp refreshed every 15 s, set to 0 by the
//    server when the owner's database connection drops).
//  - The per-peer recovery state machine: ICE restart on `failed` (at once) or after 4 s of
//    `disconnected`, a fresh RTCPeerConnection when restarts don't help or the connection object died,
//    a 20 s "couldn't connect" timeout, capped exponential backoff, and never giving up while both
//    people are in the call.
//  - Which signaling messages belong to the current connection ("generations", see classifySignal).
//  - The ICE server list (several public STUN servers plus admin TURN).

export const HB_MS = 15_000; // heartbeat interval
export const HB_STALE_MS = 45_000; // a slot without a heartbeat for this long is gone (rules agree)
export const AWAY_GRACE_MS = 6_000; // hb = 0 (owner offline) and no working media path for this long: gone
export const VIEWER_AWAY_MS = 20_000; // the same for people who only see the participant list
export const DISCONNECT_GRACE_MS = 4_000; // `disconnected` for longer than this: restart ICE
export const FIRST_CONNECT_PATIENCE_MS = 12_000; // never connected (or stuck negotiating): try again
export const CONNECT_TIMEOUT_MS = 20_000; // show "couldn't connect" (and keep retrying)
export const MAX_ICE_RESTARTS = 3; // ICE restarts in a row before starting a fresh connection
export const BACKOFF_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 30_000]);
export const POLITE_DELAY_MS = 5_000; // the polite side waits this much longer, so the impolite side leads

export const STUN_URLS = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
]);

export const STATUS_TEXT = Object.freeze({
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  connected: 'Connected',
  failed: 'Couldn’t connect — this network may need a TURN relay',
});

// ---------- Slots ----------

/**
 * 'live' | 'away' | 'stale' for a slot at server time `serverNow`. Slots written by older clients have
 * no `hb`; they are trusted (their onDisconnect removes them), and the rules never let others delete them.
 */
export function slotLiveness(slot, serverNow) {
  if (!slot || typeof slot.uid !== 'string' || !slot.uid) return 'stale';
  if (typeof slot.hb !== 'number') return 'live';
  if (slot.hb === 0) return 'away';
  return serverNow - slot.hb > HB_STALE_MS ? 'stale' : 'live';
}

// ---------- ICE servers ----------

const ICE_URL = /^(stuns?|turns?):[^\s]{1,200}$/;

function cleanUrls(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter((u) => typeof u === 'string' && ICE_URL.test(u)).slice(0, 4);
  return list.length ? list : null;
}

/** Default STUN servers merged with admin-configured TURN entries (`appConfig/turn`, at most 4). */
export function buildIceServers(turn) {
  const out = [{ urls: [...STUN_URLS] }];
  const list = Array.isArray(turn) ? turn : turn && typeof turn === 'object' ? Object.values(turn) : [];
  for (const t of list.slice(0, 4)) {
    const urls = t && typeof t === 'object' ? cleanUrls(t.urls) : null;
    if (!urls) continue;
    const e = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof t.username === 'string' && t.username) e.username = t.username.slice(0, 256);
    if (typeof t.credential === 'string' && t.credential) e.credential = t.credential.slice(0, 256);
    out.push(e);
  }
  return out;
}

// ---------- Peer recovery ----------

export function newPeerHealth(now) {
  return {
    downSince: now, // not connected since (null while connected)
    disconnectedSince: null,
    failedSince: null,
    everConnected: false,
    connected: false,
    attempts: 0, // recovery attempts since the last time it was connected
    iceRestarts: 0, // ICE restarts since the last fresh connection
    lastAttemptAt: 0,
    status: 'connecting',
  };
}

/** After building a fresh RTCPeerConnection: keep the timers (the 20 s timeout keeps counting). */
export function noteRebuilt(h, now) {
  h.connected = false;
  if (h.downSince == null) h.downSince = now;
  h.disconnectedSince = null;
  h.failedSince = null;
  h.iceRestarts = 0;
}

const isUp = (pc) => pc.conn === 'connected' || (!pc.conn && (pc.ice === 'connected' || pc.ice === 'completed'));

/**
 * One step of the recovery state machine. `pc` = `{ conn, ice, signaling, hasRemote }` (the
 * RTCPeerConnection's connectionState, iceConnectionState, signalingState, and whether it has a remote
 * description). Mutates `h` and returns `{ status, action }`, action `null | 'restart' | 'rebuild'`.
 *
 * The impolite side (lower uid) leads: it restarts ICE as soon as the connection `failed`, or after 4 s
 * of `disconnected`. The polite side does the same 5 s later, so it only acts when the other side
 * didn't (perfect negotiation resolves a collision). A connection that never came up within 12 s, or
 * whose negotiation is stuck, that was closed, or that failed after 3 ICE restarts, is replaced by a fresh one. Attempts
 * back off 2, 4, 8, 16, then every 30 s, and go on for as long as both people are in the call.
 */
export function stepPeerHealth(h, pc, { now, polite }) {
  // Closed locally (signaling) or by the other side (DTLS close_notify): only a fresh connection helps.
  if (pc.signaling === 'closed' || pc.conn === 'closed') {
    h.connected = false;
    if (h.downSince == null) h.downSince = now;
    const status = statusOf(h, now);
    h.status = status;
    if (now - h.lastAttemptAt < 1_000) return { status, action: null };
    h.attempts += 1;
    h.lastAttemptAt = now;
    return { status, action: 'rebuild' };
  }
  if (isUp(pc)) {
    if (!h.connected) {
      h.connected = true;
      h.everConnected = true;
      h.downSince = null;
      h.disconnectedSince = null;
      h.failedSince = null;
      h.attempts = 0;
      h.iceRestarts = 0;
    }
    h.status = 'connected';
    return { status: 'connected', action: null };
  }
  if (h.connected || h.downSince == null) {
    h.connected = false;
    h.downSince = now;
  }
  const failed = pc.conn === 'failed' || pc.ice === 'failed';
  const disc = !failed && (pc.conn === 'disconnected' || pc.ice === 'disconnected');
  if (disc) h.disconnectedSince ??= now;
  else h.disconnectedSince = null;
  if (failed) h.failedSince ??= now;
  else h.failedSince = null;
  const status = statusOf(h, now);
  h.status = status;

  let due;
  if (h.attempts === 0) {
    if (failed) due = h.failedSince;
    else if (disc) due = h.disconnectedSince + DISCONNECT_GRACE_MS;
    else due = h.downSince + FIRST_CONNECT_PATIENCE_MS;
  } else {
    due = h.lastAttemptAt + BACKOFF_MS[Math.min(h.attempts - 1, BACKOFF_MS.length - 1)];
  }
  if (polite) due += POLITE_DELAY_MS;
  if (now < due) return { status, action: null };

  h.attempts += 1;
  h.lastAttemptAt = now;
  const canRestart = pc.hasRemote && pc.signaling === 'stable' && h.iceRestarts < MAX_ICE_RESTARTS;
  if (canRestart) {
    h.iceRestarts += 1;
    return { status, action: 'restart' };
  }
  h.iceRestarts = 0;
  return { status, action: 'rebuild' };
}

function statusOf(h, now) {
  if (h.connected) return 'connected';
  if (h.downSince != null && now - h.downSince >= CONNECT_TIMEOUT_MS) return 'failed';
  return h.everConnected ? 'reconnecting' : 'connecting';
}

// ---------- Connection generations ----------
//
// Each side numbers its RTCPeerConnection objects for one peer (`gen`, 1, 2, …; a fresh connection
// after a failure gets the next number). Every signal carries `g` (the sender's generation) and `rg`
// (the receiver's generation the sender is talking to, once known). The receiver tracks the highest
// remote generation seen (`remoteGen`) and the one its current connection is bound to (`boundGen`).
// A message from an older remote generation, or one meant for an older local connection, is dropped.
// A newer remote generation means the other side started over: if the local connection was already
// talking to an older one, it is replaced first ("rebuild") so DTLS and ICE start fresh on both sides.
// `alias` lets the remote's new connection keep addressing the local connection by the number it
// knew when it started (it can't know the new one until it hears back).

const int = (x) => (Number.isInteger(x) && x >= 0 && x < 1e9 ? x : null);

/** Classify a decrypted signal for peer state `p` = `{ gen, remoteGen, boundGen, alias }`. */
export function classifySignal(p, data) {
  const g = int(data?.g);
  if (g == null) return { ok: true, legacy: true }; // client without generations
  const rg = int(data.rg);
  if (p.remoteGen != null && g < p.remoteGen) return { ok: false, why: 'old-remote' };
  const kind = data.desc ? data.desc.type : data.cand ? 'cand' : data.hello ? 'hello' : 'other';
  const rgOk = rg == null || rg === p.gen || (!!p.alias && p.alias.g === g && p.alias.rg === rg);
  const fresh = p.remoteGen == null || g > p.remoteGen;
  if (!fresh) return rgOk ? { ok: true, fresh: false, g } : { ok: false, why: 'old-local' };
  // A new remote connection can't know about my newest one yet: its offer or hello starts a session.
  if (!rgOk && kind !== 'offer' && kind !== 'hello') return { ok: false, why: 'old-local' };
  return { ok: true, fresh: true, g, rg, rebuild: p.boundGen != null && p.boundGen !== g };
}

/** Bind the current local connection to remote generation `g` (after a rebuild, if one was needed). */
export function bindRemote(p, g, rg) {
  p.remoteGen = g;
  p.boundGen = g;
  p.alias = rg != null && rg !== p.gen ? { g, rg } : null;
}
