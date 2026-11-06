// CallSession: one WebRTC full mesh (≤6) for one scope, with perfect negotiation per peer.
//
// Each peer pair has one RTCPeerConnection carrying my mic track and at most one video sender
// (camera or screen; switched with replaceTrack so screen share never needs a second track).
// The polite side is the higher uid. Signaling messages are AES-GCM encrypted with the scope's
// conversation key and bound to `call:{scope}/{callId}/{from}->{to}`; each payload carries the
// sender's slot `joinedAt` so leftovers from an earlier session of the same peer are dropped.
import { onChildAdded, onValue, ref, remove } from 'firebase/database';
import { db } from '../firebase.js';
import {
  claimSlot, dropInbox, ensureCall, loadIceServers, openSignal, releaseSlot, resetInbox, ringCall, scopeKeys,
  sendSignal, signalPath, slotsPath, updateSlot, callPath,
} from './core.js';
import { getCameraTrack, getMic, getScreenTrack, loadDevicePrefs, saveDevicePrefs, stopStream, watchSpeaking } from './media.js';

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
    this.slots = {};
    this.peers = new Map(); // uid -> peer
    this.mic = true;
    this.deafened = false;
    this.camTrack = null;
    this.screenTrack = null;
    this.micStream = null;
    this.outStream = new MediaStream();
    this.speaking = new Set();
    this.devices = loadDevicePrefs();
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

  /** Start or join. `ring` sends call notifications when this client started the call. */
  async start({ ring = true } = {}) {
    this.status = 'joining';
    this.emit();
    try {
      this.keys = await scopeKeys(this.scope, this.me);
      this.iceServers = await loadIceServers();
      this.micStream = await getMic(this.devices.audioIn);
      if (this.closed) return this.dispose();
      this.micStream.getAudioTracks().forEach((t) => this.outStream.addTrack(t));
      const { callId, kind, started } = await ensureCall(this.scope, this.me, this.kind);
      this.callId = callId;
      this.kind = kind;
      this.started = started;
      if (this.kind === 'video') {
        try {
          this.camTrack = await getCameraTrack(this.devices.videoIn);
          this.outStream.addTrack(this.camTrack);
        } catch (e) {
          this.error = e.message; // join audio-only; surfaced as a notice
        }
      }
      if (this.closed) return this.dispose();
      await resetInbox(this.scope, this.me);
      this.slot = await claimSlot(this.scope, this.me, { mic: this.mic, cam: this.camOn });
      if (this.closed) return this.dispose();
      this.stopLocalSpeaking = watchSpeaking(this.micStream, (on) => this.setSpeaking(this.me, on && this.mic));
      this.unsubs.push(
        onValue(ref(db, slotsPath(this.scope)), (s) => this.syncSlots(s.val() || {}), () => this.fail('Lost access to this call')),
        onValue(ref(db, `${callPath(this.scope)}/id`), (s) => {
          if (this.status === 'live' && s.val() !== this.callId) this.hangup();
        }),
      );
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

  syncSlots(slots) {
    if (this.closed) return;
    this.slots = slots;
    const present = new Map();
    for (const s of Object.values(slots)) if (s?.uid) present.set(s.uid, s);
    if (this.slot && !present.has(this.me)) {
      // My slot vanished (e.g. connection blip ran onDisconnect): end cleanly.
      this.error = 'You were disconnected from the call';
      return this.hangup();
    }
    for (const [uid, s] of present) {
      if (uid === this.me) continue;
      const p = this.peers.get(uid);
      if (p && p.joinedAt !== s.joinedAt) this.closePeer(uid);
      if (!this.peers.has(uid)) this.openPeer(uid, s.joinedAt);
    }
    for (const uid of [...this.peers.keys()]) if (!present.has(uid)) this.closePeer(uid);
    this.emit();
  }

  openPeer(uid, joinedAt) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const p = { uid, pc, joinedAt, polite: this.me > uid, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), queue: Promise.resolve(), video: null, state: 'connecting' };
    this.peers.set(uid, p);
    for (const t of this.micStream.getAudioTracks()) pc.addTrack(t, this.outStream);
    if (this.videoOut) p.video = pc.addTrack(this.videoOut, this.outStream);

    const send = (payload) =>
      sendSignal({ scope: this.scope, callId: this.callId, me: this.me, to: uid, keys: this.keys, payload: { ...payload, j: this.slot?.joinedAt } }).catch(() => {});

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        send({ desc: pc.localDescription.toJSON() });
      } catch {
        // superseded by a newer negotiation
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ cand: candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce?.();
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      this.emit();
    };
    pc.ontrack = ({ track }) => {
      p.stream.addTrack(track);
      if (track.kind === 'audio' && !p.stopSpeaking) p.stopSpeaking = watchSpeaking(new MediaStream([track]), (on) => this.setSpeaking(uid, on));
      track.onended = () => {
        p.stream.removeTrack(track);
        this.emit();
      };
      this.emit();
    };

    const inbox = ref(db, `${signalPath(this.scope)}/${this.me}/${uid}`);
    p.unsub = onChildAdded(inbox, (snap) => {
      const msg = snap.val();
      p.queue = p.queue
        .then(() => this.handleSignal(p, msg, send))
        .catch(() => {})
        .finally(() => remove(snap.ref).catch(() => {}));
    });
  }

  async handleSignal(p, msg, send) {
    if (this.closed || this.peers.get(p.uid) !== p) return;
    let data;
    try {
      data = await openSignal({ scope: this.scope, callId: this.callId, me: this.me, from: p.uid, keys: this.keys, msg });
    } catch {
      return; // wrong call / tampered / stale epoch: drop
    }
    if (data.j !== p.joinedAt) return;
    const { pc } = p;
    if (data.desc) {
      const desc = data.desc;
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        send({ desc: pc.localDescription.toJSON() });
      }
    } else if (data.cand) {
      try {
        await pc.addIceCandidate(data.cand);
      } catch (e) {
        if (!p.ignoreOffer) throw e;
      }
    }
  }

  closePeer(uid) {
    const p = this.peers.get(uid);
    if (!p) return;
    this.peers.delete(uid);
    p.unsub?.();
    p.stopSpeaking?.();
    this.speaking.delete(uid);
    p.pc.ontrack = p.pc.onicecandidate = p.pc.onnegotiationneeded = p.pc.onconnectionstatechange = p.pc.oniceconnectionstatechange = null;
    try {
      p.pc.close();
    } catch {
      // already closed
    }
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
      else if (t) p.video = p.pc.addTrack(t, this.outStream);
    }
  }

  toggleMic() {
    this.mic = !this.mic;
    this.micStream?.getAudioTracks().forEach((t) => (t.enabled = this.mic));
    if (!this.mic) this.speaking.delete(this.me);
    this.pushFlags();
    this.emit();
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    if (this.deafened && this.mic) this.toggleMic();
    this.emit();
  }

  async toggleCam() {
    if (this.camTrack) {
      this.camTrack.stop();
      this.camTrack = null;
    } else {
      this.camTrack = await getCameraTrack(this.devices.videoIn);
      if (this.closed) return this.camTrack.stop();
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

  /** Change input/output devices. `audioOut` is applied by the UI via setSinkId. */
  async setDevices(patch) {
    this.devices = { ...this.devices, ...patch };
    saveDevicePrefs(this.devices);
    if (patch.audioIn !== undefined && this.micStream) {
      const next = await getMic(patch.audioIn);
      const track = next.getAudioTracks()[0];
      track.enabled = this.mic;
      const old = this.micStream;
      for (const p of this.peers.values()) {
        const s = p.pc.getSenders().find((x) => x.track?.kind === 'audio');
        if (s) await s.replaceTrack(track).catch(() => {});
      }
      this.outStream.getAudioTracks().forEach((t) => this.outStream.removeTrack(t));
      this.outStream.addTrack(track);
      this.micStream = next;
      this.stopLocalSpeaking?.();
      this.stopLocalSpeaking = watchSpeaking(next, (on) => this.setSpeaking(this.me, on && this.mic));
      stopStream(old);
    }
    if (patch.videoIn !== undefined && this.camTrack) {
      const t = await getCameraTrack(patch.videoIn);
      this.camTrack.stop();
      this.camTrack = t;
      this.applyVideo();
    }
    this.emit();
  }

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
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const uid of [...this.peers.keys()]) this.closePeer(uid);
    this.stopLocalSpeaking?.();
    stopStream(this.micStream);
    this.camTrack?.stop();
    this.screenTrack?.stop();
    this.camTrack = this.screenTrack = null;
    this.speaking.clear();
    const slot = this.slot;
    this.slot = null;
    this.released = Promise.all([slot ? releaseSlot(this.scope, slot.index) : null, dropInbox(this.scope, this.me)]).catch(() => {});
    this.emit();
    return this;
  }
}
