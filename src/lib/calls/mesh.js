// CallSession: one WebRTC full mesh (≤6) for one scope, with perfect negotiation per peer.
//
// Each peer pair has one RTCPeerConnection carrying my mic track, at most one video sender (camera or
// screen; switched with replaceTrack so screen share never needs a second track) and a negotiated data
// channel for small in-call events (raise hand, reactions). The polite side is the higher uid.
// Signaling messages are AES-GCM encrypted with the scope's conversation key and bound to
// `call:{scope}/{callId}/{from}->{to}`. Messages whose server `ts` is older than the sender's current
// slot `joinedAt` are leftovers from an earlier session and dropped.
//
// Reliability (see ./health.js): a watchdog checks every peer once a second and restarts ICE or builds
// a fresh connection when it fails, stays disconnected, or never comes up; each tile shows the peer's
// status. My slot carries a heartbeat; slots of people whose tab crashed or froze are removed by the
// others. If my own slot is lost while my connection was down, the session claims a new one by itself.
import { onChildAdded, onValue, ref, remove, serverTimestamp } from 'firebase/database';
import { db } from '../firebase.js';
import { randomId } from '../crypto.js';
import {
  armSlotDisconnect, callPath, claimSlot, dropInbox, ensureCall, loadIceServers, openSignal, releaseSlot, removeSlot,
  resetInbox, ringCall, scopeKeys, sendSignal, serverNow, signalPath, slotsPath, updateSlot,
} from './core.js';
import {
  AWAY_GRACE_MS, HB_MS, HB_STALE_MS, bindRemote, classifySignal, newPeerHealth, noteRebuilt, slotLiveness, stepPeerHealth,
} from './health.js';
import { REACTIONS, REACTION_MS, createRateLimiter, encodeEvent, fixRaiseTime, parseCallEvent } from './events.js';
import { getCameraTrack, getMic, getScreenTrack, stopStream, watchRemoteSpeaking, watchSpeaking } from './media.js';
import { loadPrefs, savePrefs, subscribePrefs } from './prefs.js';

const WATCHDOG_MS = 1_000;
const MAX_REJOINS = 4; // per 2 minutes

const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));

export class CallSession {
  constructor({ scope, me, kind = 'audio', onChange }) {
    this.scope = scope;
    this.me = me;
    this.kind = kind === 'video' ? 'video' : 'audio';
    this.onChange = onChange || (() => {});
    this.status = 'idle'; // idle | joining | live | ended | error
    this.error = null;
    this.callId = null;
    this.slot = null; // { index, joinedAt }
    this.slots = {}; // visible slots (ghosts filtered out)
    this.slotsRaw = {};
    this.peers = new Map(); // uid -> peer
    this.mic = true;
    this.deafened = false;
    this.camTrack = null;
    this.camPending = null;
    this.screenTrack = null;
    this.micStream = null;
    this.outStream = new MediaStream();
    this.speaking = new Set();
    this.prefs = loadPrefs();
    this.ptt = this.prefs.ptt;
    this.pttHeld = false;
    this.hands = new Map(); // uid -> raised at (server-clock ms)
    this.reactions = []; // [{ id, uid, e }]
    this.reactionSeq = 0;
    this.eventLimiter = createRateLimiter({ capacity: 8, refillMs: 500 });
    this.reactLimiter = createRateLimiter({ capacity: 5, refillMs: 600 });
    this.myReactLimiter = createRateLimiter({ capacity: 4, refillMs: 750 });
    this.myHandLimiter = createRateLimiter({ capacity: 4, refillMs: 1_000 });
    this.tag = randomId(8); // changes with every slot I claim, sent with each signal
    this.dbConnected = null;
    this.reconnectedAt = 0;
    this.lastBeatOk = 0;
    this.lastOwnAway = false;
    this.awaySince = new Map(); // `${uid}:${joinedAt}` -> local ms first seen offline
    this.ghostsRemoved = new Set();
    this.rejoining = false;
    this.rejoins = [];
    this.lastTick = Date.now();
    this.stalledAt = 0;
    this.staleViewUntil = 0; // my copy of the slots may be out of date until then (offline, or tab was stalled)
    this.timers = [];
    this.unsubs = [];
    this.closed = false;
    this.started = false;
  }

  emit() {
    if (!this.closed || this.status === 'ended' || this.status === 'error') this.onChange(this);
  }

  get camOn() {
    return !!this.camTrack;
  }

  get screenOn() {
    return !!this.screenTrack;
  }

  get videoOut() {
    return this.screenTrack || this.camTrack || null;
  }

  /** Whether my microphone is actually sent: unmuted, and in push-to-talk mode only while the key is held. */
  get transmitting() {
    return this.mic && (!this.ptt || this.pttHeld);
  }

  /** Back-compat alias used by the UI. */
  get devices() {
    return this.prefs;
  }

  /** Start or join. `ring` sends call notifications when this client started the call. */
  async start({ ring = true } = {}) {
    this.status = 'joining';
    this.emit();
    serverNow(); // start the server clock listener early
    try {
      this.keys = await scopeKeys(this.scope, this.me);
      this.iceServers = await loadIceServers();
      this.micStream = await getMic(this.prefs.audioIn, this.prefs);
      if (this.closed) return this.dispose();
      this.micStream.getAudioTracks().forEach((t) => this.outStream.addTrack(t));
      this.applyTransmit();
      const { callId, kind, started } = await ensureCall(this.scope, this.me, this.kind);
      this.callId = callId;
      this.kind = kind;
      this.started = started;
      // Audio never waits for the camera: it starts in the background and is added when it's ready.
      if (this.kind === 'video') this.startCamera();
      if (this.closed) return this.dispose();
      await resetInbox(this.scope, this.me);
      const flags = { mic: this.mic, cam: this.camOn, screen: false };
      this.slot = await claimSlot(this.scope, this.me, flags);
      this.tag = randomId(8);
      this.lastBeatOk = Date.now();
      if (this.closed) return this.dispose();
      this.syncFlags(flags);
      this.stopLocalSpeaking = watchSpeaking(this.micStream, (on) => this.setSpeaking(this.me, on && this.transmitting));
      this.unsubs.push(
        onValue(ref(db, slotsPath(this.scope)), (s) => this.syncSlots(s.val() || {}), () => this.fail('Lost access to this call')),
        onValue(ref(db, `${callPath(this.scope)}/id`), (s) => {
          if (this.status === 'live' && s.val() !== this.callId) this.hangup();
        }),
        onValue(ref(db, '.info/connected'), (s) => this.onConnection(s.val() === true)),
      );
      this.lastTick = Date.now();
      this.timers.push(setInterval(() => this.watchdog(), WATCHDOG_MS), setInterval(() => this.beat(), HB_MS));
      this.installPushToTalk();
      this.unsubs.push(subscribePrefs((next) => this.onPrefs(next)));
      this.status = 'live';
      this.emit();
      if (started && ring) ringCall(this.scope, this.me, this.callId).catch(() => {});
    } catch (e) {
      this.fail(e?.message || 'Could not join the call');
    }
    return this;
  }

  fail(message) {
    this.error = message;
    this.status = 'error';
    return this.dispose();
  }

  setSpeaking(uid, on) {
    if (on === this.speaking.has(uid)) return;
    if (on) this.speaking.add(uid);
    else this.speaking.delete(uid);
    this.emit();
  }

  // ---------- Slots, heartbeat, ghosts ----------

  beat() {
    const slot = this.slot;
    if (!slot || this.closed) return;
    const sentAt = Date.now(); // not the ack time: an ack processed after a stall would look fresh
    updateSlot(this.scope, slot.index, { hb: serverTimestamp(), away: null }).then(() => {
      if (this.slot === slot) this.lastBeatOk = Math.max(this.lastBeatOk, sentAt);
    }, () => {});
  }

  onConnection(up) {
    const was = this.dbConnected;
    this.dbConnected = up;
    if (!up) {
      this.staleViewUntil = Infinity; // others' heartbeats look old only because I don't receive them
      return;
    }
    if (was !== false || this.closed) return;
    // Back online: the server ran my onDisconnect (away). Re-arm it and refresh the heartbeat.
    this.reconnectedAt = Date.now();
    this.staleViewUntil = this.reconnectedAt + 5_000;
    if (this.slot) {
      armSlotDisconnect(this.scope, this.slot.index);
      this.beat();
    }
  }

  syncSlots(slots) {
    if (this.closed) return;
    this.slotsRaw = slots;
    this.reconcile(true);
  }

  /** Open/close peers to match the live slots; drop ghosts. `force` emits even without changes. */
  reconcile(force = false) {
    if (this.closed) return;
    const slots = this.slotsRaw || {};
    const now = serverNow();
    const local = Date.now();
    if (this.slot && !this.rejoining) {
      const own = slots[this.slot.index];
      if (!own || own.uid !== this.me) return this.onOwnSlotLost();
      this.lastOwnAway = own.away === true;
      if (typeof own.joinedAt === 'number') this.slot.joinedAt = own.joinedAt;
      if (own.away === true && this.dbConnected) this.beat(); // marked away by a stale onDisconnect
    }
    const visible = {};
    const present = new Map();
    let changed = force;
    const judge = local >= this.staleViewUntil;
    for (const [i, s] of Object.entries(slots)) {
      if (!s?.uid) continue;
      if (s.uid !== this.me && judge && this.isGhost(i, s, now, local)) continue;
      visible[i] = s;
      if (s.uid !== this.me) present.set(s.uid, s);
    }
    for (const [uid, s] of present) {
      const p = this.peers.get(uid);
      if (p && p.joinedAt !== s.joinedAt) {
        this.closePeer(uid);
        changed = true;
      }
      if (!this.peers.has(uid) && this.slot && !this.rejoining) {
        this.openPeer(uid, s.joinedAt);
        changed = true;
      }
    }
    for (const uid of [...this.peers.keys()]) {
      if (!present.has(uid)) {
        this.closePeer(uid);
        changed = true;
      }
    }
    if (!changed && Object.keys(visible).join() === Object.keys(this.slots).join()) return;
    this.slots = visible;
    this.emit();
  }

  /**
   * A slot whose owner is gone: heartbeat 45 s old (removed: the rules allow it), or away with no
   * working media path for 6 s (hidden and its connection closed, but never removed before its 45 s
   * grace: it comes back as soon as the owner's heartbeat does).
   */
  isGhost(index, s, now, local) {
    const live = slotLiveness(s, now);
    const key = `${s.uid}:${s.joinedAt}`;
    if (live === 'live') {
      this.awaySince.delete(key);
      return false;
    }
    if (live === 'away') {
      const p = this.peers.get(s.uid);
      if (p?.health.connected) {
        this.awaySince.delete(key); // only their database link dropped; media still flows
        return false;
      }
      if (!this.awaySince.has(key)) this.awaySince.set(key, local);
      return local - this.awaySince.get(key) >= AWAY_GRACE_MS;
    }
    const gk = `${index}:${key}:${s.hb}`;
    if (!this.ghostsRemoved.has(gk)) {
      this.ghostsRemoved.add(gk);
      // Retried on the next check if refused (the server clock may be a moment behind mine).
      removeSlot(this.scope, Number(index)).catch(() => this.ghostsRemoved.delete(gk));
    }
    return true;
  }

  onOwnSlotLost() {
    if (this.closed || this.rejoining) return;
    const now = Date.now();
    // Lost while my connection was down or my tab was frozen (others then remove the slot): rejoin.
    // Removed while I was online and beating (e.g. a server admin disconnected me): end the call.
    const wasAway = this.dbConnected === false || this.lastOwnAway || now - this.lastBeatOk > HB_STALE_MS - 5_000
      || now - this.reconnectedAt < 20_000 || now - this.stalledAt < 20_000 || now - this.lastTick > 5_000;
    if (!wasAway) {
      this.error = 'You were disconnected from the call';
      this.hangup();
      return;
    }
    this.rejoin();
  }

  async rejoin() {
    const now = Date.now();
    this.rejoins = this.rejoins.filter((t) => now - t < 120_000);
    if (this.rejoins.length >= MAX_REJOINS) return this.fail('Lost the connection to the call');
    this.rejoins.push(now);
    this.rejoining = true;
    this.slot = null;
    for (const uid of [...this.peers.keys()]) this.closePeer(uid);
    this.emit();
    try {
      const flags = { mic: this.mic, cam: this.camOn, screen: this.screenOn };
      const slot = await claimSlot(this.scope, this.me, flags);
      if (this.closed) {
        releaseSlot(this.scope, slot.index);
        return undefined;
      }
      this.slot = slot;
      this.tag = randomId(8);
      this.lastBeatOk = Date.now();
      this.syncFlags(flags);
    } catch (e) {
      this.rejoining = false;
      return this.fail(e?.message || 'Could not rejoin the call');
    }
    this.rejoining = false;
    this.reconcile(true);
    return undefined;
  }

  watchdog() {
    if (this.closed) return;
    const t = Date.now();
    // The tab was frozen or stuck: wait for fresh data before judging anyone's heartbeat.
    if (t - this.lastTick > 5_000) {
      this.stalledAt = t;
      this.staleViewUntil = Math.max(this.staleViewUntil, t + 5_000);
    }
    this.lastTick = t;
    for (const p of this.peers.values()) this.checkPeer(p);
    this.reconcile(false);
  }

  // ---------- Peers ----------

  openPeer(uid, joinedAt) {
    const p = {
      uid, joinedAt, polite: this.me > uid, gen: 0, remoteGen: null, boundGen: null, alias: null, remoteTag: null,
      pc: null, dc: null, stream: new MediaStream(), video: null, makingOffer: false, ignoreOffer: false, pendingCands: [],
      queue: Promise.resolve(), sendQueue: Promise.resolve(), health: newPeerHealth(Date.now()), status: 'connecting', closed: false,
    };
    this.peers.set(uid, p);
    this.setupPc(p);

    const inbox = ref(db, `${signalPath(this.scope)}/${this.me}/${uid}`);
    // Each message is handled once. If deleting it fails, the SDK restores it locally and fires
    // onChildAdded again; replaying an offer or answer would wreck the negotiation. A message from a
    // newer session of this peer (its slot changed but my slot listener hasn't caught up) is left in
    // place for the peer object that replaces this one.
    const handled = new Set();
    p.unsub = onChildAdded(inbox, (snap) => {
      if (handled.has(snap.key)) return;
      handled.add(snap.key);
      const msg = snap.val();
      this.enqueue(p, async () => {
        let r;
        try {
          r = await this.handleSignal(p, msg);
        } finally {
          if (r !== 'defer') remove(snap.ref).catch(() => {});
        }
      });
    });
  }

  /** Run pc-changing work for one peer strictly in order. */
  enqueue(p, fn) {
    p.queue = p.queue.then(fn).catch(() => {});
    return p.queue;
  }

  /** Outgoing signals for one peer, sent strictly in order (a candidate must not overtake its offer). */
  send(p, payload) {
    const msg = { ...payload, g: p.gen, tj: p.joinedAt, s: this.tag, j: this.slot?.joinedAt };
    if (p.remoteGen != null) msg.rg = p.remoteGen;
    const keys = this.keys;
    const callId = this.callId;
    p.sendQueue = p.sendQueue
      .then(() => sendSignal({ scope: this.scope, callId, me: this.me, to: p.uid, keys, payload: msg }))
      .catch(() => {});
    return p.sendQueue;
  }

  /** A new RTCPeerConnection (generation + 1) for peer `p`, with my tracks and the event channel. */
  setupPc(p) {
    p.gen += 1;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    Object.assign(p, { pc, boundGen: null, alias: null, pendingCands: [], makingOffer: false, ignoreOffer: false, video: null, stream: new MediaStream() });
    for (const t of this.micStream.getAudioTracks()) pc.addTrack(t, this.outStream);
    if (this.videoOut) p.video = pc.addTrack(this.videoOut, this.outStream);
    this.setupChannel(p, pc);

    pc.onnegotiationneeded = async () => {
      if (p.pc !== pc) return;
      // The first negotiation of a connection is always offered by the impolite side (lower uid). If both
      // offered at once, the polite side would roll its offer back, and when that happens before it
      // gathered any candidates Chrome gathers none afterwards: the peer then waits at "Connecting…"
      // forever. Later renegotiations (camera, screen share, ICE restarts) may come from either side.
      if (p.polite && !pc.remoteDescription) return;
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        if (p.pc === pc) this.send(p, { desc: pc.localDescription.toJSON() });
      } catch {
        // superseded by a newer negotiation
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && p.pc === pc) this.send(p, { cand: candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = pc.onconnectionstatechange = () => {
      if (p.pc === pc) this.checkPeer(p);
    };
    pc.ontrack = ({ track, receiver }) => {
      if (p.pc !== pc) return;
      p.stream.addTrack(track);
      if (track.kind === 'audio') {
        // Their ring follows the levels this browser measures for the audio it receives (no Web Audio).
        // One watcher per connection, on its current receiver; teardownPc stops it.
        p.stopSpeaking?.();
        p.speakTrack = track;
        p.stopSpeaking = watchRemoteSpeaking(receiver || { track }, (on) => {
          if (p.pc === pc && !p.closed) this.setSpeaking(p.uid, on);
        });
      }
      track.onended = () => {
        p.stream.removeTrack(track);
        if (p.speakTrack === track) this.stopPeerSpeaking(p);
        this.emit();
      };
      this.emit();
    };
  }

  /** Stop watching whether `p` speaks and clear their ring. */
  stopPeerSpeaking(p) {
    p.stopSpeaking?.();
    p.stopSpeaking = null;
    p.speakTrack = null;
    this.speaking.delete(p.uid);
  }

  /** Detach and close the current connection of `p`. */
  teardownPc(p) {
    const { pc, dc } = p;
    this.stopPeerSpeaking(p);
    if (dc) {
      dc.onopen = dc.onmessage = null;
      try {
        dc.close();
      } catch {
        // already closed
      }
    }
    p.dc = null;
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
  }

  /**
   * Replace the connection to `p` with a fresh one. `respond`: the other side already started over (its
   * offer is being handled); otherwise the polite side says hello so the impolite side offers again.
   */
  rebuildPeer(p, { respond = false } = {}) {
    if (p.closed || this.closed) return;
    this.teardownPc(p);
    this.speaking.delete(p.uid);
    noteRebuilt(p.health, Date.now());
    this.setupPc(p);
    if (p.polite && !respond) this.send(p, { hello: 1 });
    this.emit();
  }

  async restartIce(p) {
    const { pc } = p;
    if (p.closed || pc.signalingState !== 'stable') return;
    if (typeof pc.restartIce === 'function') {
      pc.restartIce(); // onnegotiationneeded sends the new offer
      return;
    }
    p.makingOffer = true;
    try {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      if (p.pc === pc) this.send(p, { desc: pc.localDescription.toJSON() });
    } finally {
      p.makingOffer = false;
    }
  }

  checkPeer(p) {
    if (p.closed || !p.pc) return;
    const { pc } = p;
    const { status, action } = stepPeerHealth(
      p.health,
      { conn: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, hasRemote: !!pc.remoteDescription },
      { now: Date.now(), polite: p.polite },
    );
    if (status !== p.status) {
      p.status = status;
      this.emit();
    }
    if (action === 'restart') this.enqueue(p, () => this.restartIce(p));
    else if (action === 'rebuild') this.enqueue(p, () => this.rebuildPeer(p));
  }

  async handleSignal(p, msg) {
    if (this.closed || p.closed || this.peers.get(p.uid) !== p) return undefined;
    let data;
    try {
      data = await openSignal({ scope: this.scope, callId: this.callId, me: this.me, from: p.uid, keys: this.keys, msg });
    } catch {
      return undefined; // wrong call / tampered / stale epoch: drop
    }
    if (!data || typeof data !== 'object') return undefined;
    // Leftovers from an earlier session of this peer were sent before its current slot existed. Both
    // msg.ts and the slot's joinedAt are server timestamps (the rules require `now`), so they compare
    // reliably. (The sender's own copy of joinedAt is NOT reliable: a transaction resolves
    // serverTimestamp() locally, so it can be off by the round-trip time. Matching on it dropped
    // every signal and left calls stuck at "Connecting…".)
    if (typeof msg?.ts === 'number' && typeof p.joinedAt === 'number' && msg.ts < p.joinedAt) return undefined;
    // Meant for an earlier slot of mine (I rejoined since): the sender learned my joinedAt from the slots.
    if (typeof data.tj === 'number' && this.slot && data.tj !== this.slot.joinedAt) return undefined;
    if (typeof data.s === 'string') {
      if (p.remoteTag && data.s !== p.remoteTag) return 'defer';
      p.remoteTag = data.s;
    }
    const c = classifySignal(p, data);
    if (!c.ok) return undefined;
    if (c.fresh) {
      if (c.rebuild) this.rebuildPeer(p, { respond: true });
      bindRemote(p, c.g, c.rg);
    }
    const { pc } = p;
    if (data.desc && typeof data.desc === 'object') {
      const desc = data.desc;
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return undefined;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        if (p.pc === pc) this.send(p, { desc: pc.localDescription.toJSON() });
      }
      // Candidates that arrived before any remote description.
      const early = p.pendingCands.splice(0);
      for (const cand of early) await pc.addIceCandidate(cand).catch(() => {});
    } else if (data.cand && typeof data.cand === 'object') {
      if (!pc.remoteDescription) {
        if (p.pendingCands.length < 100) p.pendingCands.push(data.cand);
        return undefined;
      }
      try {
        await pc.addIceCandidate(data.cand);
      } catch (e) {
        if (!p.ignoreOffer) throw e;
      }
    }
    return undefined;
  }

  closePeer(uid) {
    const p = this.peers.get(uid);
    if (!p) return;
    p.closed = true;
    this.peers.delete(uid);
    p.unsub?.();
    this.teardownPc(p);
    this.speaking.delete(uid);
    this.hands.delete(uid);
    this.eventLimiter.forget(uid);
  }

  // ---------- In-call events (data channel) ----------

  setupChannel(p, pc) {
    let dc;
    try {
      // Negotiated on both sides with the same id: no in-band announcement, works with either side offering.
      dc = pc.createDataChannel('codehub-events', { negotiated: true, id: 0, ordered: true });
    } catch {
      return;
    }
    p.dc = dc;
    dc.onopen = () => {
      if (p.dc !== dc) return;
      const at = this.hands.get(this.me);
      this.sendEvent(p, { t: 'state', hand: { up: at != null, at: at ?? null } });
    };
    dc.onmessage = (e) => {
      if (p.dc === dc && !p.closed) this.onEvent(p.uid, e.data);
    };
  }

  sendEvent(p, ev) {
    if (p.dc?.readyState !== 'open') return;
    try {
      p.dc.send(encodeEvent(ev));
    } catch {
      // channel closing
    }
  }

  broadcast(ev) {
    for (const p of this.peers.values()) this.sendEvent(p, ev);
  }

  onEvent(uid, raw) {
    const now = Date.now();
    if (!this.eventLimiter.take(uid, now)) return;
    const ev = parseCallEvent(raw);
    if (!ev) return;
    if (ev.t === 'react') {
      if (this.reactLimiter.take(uid, now)) this.addReaction(uid, ev.e);
      return;
    }
    const h = ev.t === 'hand' ? ev : ev.hand;
    this.setHand(uid, h.up, fixRaiseTime(h.at, serverNow()));
  }

  setHand(uid, up, at) {
    if (up === this.hands.has(uid) && (!up || this.hands.get(uid) === at)) return;
    if (up) this.hands.set(uid, at);
    else this.hands.delete(uid);
    this.emit();
  }

  /** Raise or lower my hand (toggles when `up` is omitted). */
  raiseHand(up = !this.hands.has(this.me)) {
    if (this.status !== 'live' || !this.myHandLimiter.take(this.me, Date.now())) return false;
    const at = serverNow();
    this.setHand(this.me, !!up, at);
    this.broadcast({ t: 'hand', up: !!up, at });
    return true;
  }

  addReaction(uid, e) {
    const id = ++this.reactionSeq;
    this.reactions = [...this.reactions.slice(-29), { id, uid, e }];
    this.emit();
    setTimeout(() => {
      this.reactions = this.reactions.filter((r) => r.id !== id);
      this.emit();
    }, REACTION_MS);
  }

  /** Send a reaction (one of REACTIONS). Returns false when rate-limited. */
  react(e) {
    if (this.status !== 'live' || !REACTIONS.includes(e)) return false;
    if (!this.myReactLimiter.take(this.me, Date.now())) return false;
    this.addReaction(this.me, e);
    this.broadcast({ t: 'react', e });
    return true;
  }

  // ---------- Local media ----------

  /** The camera may have started (or mic/screen changed) while the slot was being claimed: catch up. */
  syncFlags(claimed) {
    if (claimed.mic !== this.mic || claimed.cam !== this.camOn || claimed.screen !== this.screenOn) this.pushFlags();
  }

  async pushFlags() {
    if (!this.slot || this.closed) return;
    await updateSlot(this.scope, this.slot.index, { mic: this.mic, cam: this.camOn, screen: this.screenOn }).catch(() => {});
  }

  /** Swap the outgoing video on every peer (adds a sender, and so renegotiates, only the first time). */
  applyVideo() {
    const t = this.videoOut;
    this.outStream.getVideoTracks().forEach((v) => this.outStream.removeTrack(v));
    if (t) this.outStream.addTrack(t);
    for (const p of this.peers.values()) {
      if (p.video) p.video.replaceTrack(t).catch(() => {});
      else if (t) {
        try {
          p.video = p.pc.addTrack(t, this.outStream);
        } catch {
          // connection being replaced: the new one picks up videoOut
        }
      }
    }
  }

  applyTransmit() {
    const on = this.transmitting;
    this.micStream?.getAudioTracks().forEach((t) => (t.enabled = on));
    if (!on) this.speaking.delete(this.me);
  }

  startCamera() {
    const pending = getCameraTrack(this.prefs.videoIn);
    this.camPending = pending;
    pending.then(
      (t) => {
        if (this.camPending !== pending || this.closed) return t.stop();
        this.camPending = null;
        this.camTrack = t;
        this.applyVideo();
        this.pushFlags();
        this.emit();
        return undefined;
      },
      (e) => {
        if (this.camPending !== pending) return;
        this.camPending = null;
        this.error = e?.message || 'Could not start your camera'; // stay in the call audio-only
        this.emit();
      },
    );
    this.emit();
  }

  toggleMic() {
    this.mic = !this.mic;
    this.applyTransmit();
    this.pushFlags();
    this.emit();
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    if (this.deafened && this.mic) this.toggleMic();
    this.emit();
  }

  async toggleCam() {
    if (this.camPending) {
      this.camPending = null; // cancel a camera that is still starting
      this.emit();
      return;
    }
    if (this.camTrack) {
      this.camTrack.stop();
      this.camTrack = null;
    } else {
      const t = await getCameraTrack(this.prefs.videoIn);
      if (this.closed) return t.stop();
      this.camTrack = t;
    }
    this.applyVideo();
    this.pushFlags();
    this.emit();
  }

  async toggleScreen() {
    if (this.screenTrack) {
      this.screenTrack.onended = null;
      this.screenTrack.stop();
      this.screenTrack = null;
    } else {
      let t;
      try {
        t = await getScreenTrack();
      } catch (e) {
        if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return; // picker cancelled
        throw e;
      }
      if (this.closed) return t.stop();
      t.onended = () => {
        if (this.screenTrack === t) this.toggleScreen();
      };
      this.screenTrack = t;
    }
    this.applyVideo();
    this.pushFlags();
    this.emit();
  }

  // ---------- Push-to-talk ----------

  setPtt(on) {
    savePrefs({ ptt: !!on }); // applied through onPrefs
  }

  pttPress(down) {
    if (!this.ptt || this.pttHeld === !!down || this.closed) return;
    this.pttHeld = !!down;
    this.applyTransmit();
    this.emit();
  }

  installPushToTalk() {
    if (typeof window === 'undefined') return;
    const keyMatch = (e) => e.code === this.prefs.pttKey;
    const down = (e) => {
      if (!this.ptt || !keyMatch(e) || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      e.preventDefault();
      if (!e.repeat) this.pttPress(true);
    };
    const up = (e) => {
      if (keyMatch(e)) this.pttPress(false);
    };
    const release = () => this.pttPress(false);
    const vis = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', vis);
    this.unsubs.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', vis);
    });
  }

  // ---------- Devices ----------

  /**
   * Change devices / processing / push-to-talk prefs. They are saved for this browser and applied live
   * through onPrefs (the settings tab saves prefs directly and reaches the call the same way).
   * `audioOut` is applied by the UI (setSinkId).
   */
  async setDevices(patch) {
    savePrefs(patch);
    await this.prefsQueue;
  }

  /** Apply saved prefs to the running call, one change set at a time. */
  onPrefs(next) {
    this.prefsQueue = (this.prefsQueue || Promise.resolve()).then(async () => {
      if (this.closed) return;
      const prev = this.prefs;
      this.prefs = next;
      if (next.ptt !== this.ptt) {
        this.ptt = next.ptt;
        this.pttHeld = false;
        this.applyTransmit();
      }
      if (['audioIn', 'ec', 'ns', 'agc'].some((k) => next[k] !== prev[k]) && this.micStream) await this.swapMic();
      if (next.videoIn !== prev.videoIn && this.camTrack && !this.closed) {
        const t = await getCameraTrack(next.videoIn);
        if (this.closed || !this.camTrack) t.stop();
        else {
          this.camTrack.stop();
          this.camTrack = t;
          this.applyVideo();
        }
      }
      this.emit();
    }).catch((e) => {
      this.error = e?.message || 'Could not switch devices';
      this.emit();
    });
    return this.prefsQueue;
  }

  /** Re-acquire the microphone with the current prefs and swap it into every connection (replaceTrack). */
  async swapMic() {
    const next = await getMic(this.prefs.audioIn, this.prefs);
    if (this.closed) return stopStream(next);
    const track = next.getAudioTracks()[0];
    const old = this.micStream;
    for (const p of this.peers.values()) {
      const s = p.pc.getSenders().find((x) => x.track?.kind === 'audio');
      if (s) await s.replaceTrack(track).catch(() => {});
    }
    this.outStream.getAudioTracks().forEach((t) => this.outStream.removeTrack(t));
    this.outStream.addTrack(track);
    this.micStream = next;
    this.applyTransmit();
    this.stopLocalSpeaking?.();
    this.stopLocalSpeaking = watchSpeaking(next, (on) => this.setSpeaking(this.me, on && this.transmitting));
    stopStream(old);
    return undefined;
  }

  // ---------- Leaving ----------

  /** Hang up: stop tracks, close peers, drop listeners, slot and inbox. Safe to call twice. */
  async hangup() {
    if (this.closed) return;
    this.status = this.status === 'error' ? 'error' : 'ended';
    await this.dispose().released;
  }

  dispose() {
    if (this.closed) return this;
    this.closed = true;
    if (this.status !== 'error') this.status = 'ended';
    // Release first, synchronously: on pagehide nothing after an await reaches the network.
    const slot = this.slot;
    this.slot = null;
    this.released = Promise.all([slot ? releaseSlot(this.scope, slot.index) : null, dropInbox(this.scope, this.me)]).catch(() => {});
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const uid of [...this.peers.keys()]) this.closePeer(uid);
    this.stopLocalSpeaking?.();
    stopStream(this.micStream);
    this.camPending = null;
    this.camTrack?.stop();
    this.screenTrack?.stop();
    this.camTrack = this.screenTrack = null;
    this.speaking.clear();
    this.hands.clear();
    this.reactions = [];
    this.pttHeld = false;
    this.emit();
    return this;
  }
}
