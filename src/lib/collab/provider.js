// Encrypted Yjs-over-Realtime-Database provider.
//
// Layout (see ARCHITECTURE.md), relative to space.base (collab/{sid}/{cid} or csCollab/{csid}):
//   {base}/updates/{fid}/{pushId}   { iv, ct, uid, ts }   encrypted Yjs update (append-only)
//   {base}/snapshots/{fid}          { iv, ct, upTo, ts }  encrypted Y.encodeStateAsUpdate
//   {base}/awareness/{fid}/{uid}    { iv, ct, ts }        encrypted awareness update
// AAD strings come from the space descriptor (collab/space.js).
//
// Read-only mode (codespace viewers): local edits are never written, and this client never
// compacts. Awareness (cursor) is still broadcast — the rules allow viewers to write their own.
//
// Load: apply the snapshot, then every remaining update (Yjs merges are idempotent and
// order-independent, so duplicates or out-of-order delivery are harmless). We keep listening
// to the snapshot too, so if another member compacts while we load we still converge.
//
// Compaction (any member): when more than COMPACT_THRESHOLD updates are live, write a new
// snapshot with a compare-and-swap transaction against the snapshot we last applied, then
// delete exactly the update keys we had applied. A key we never saw is never deleted, so an
// update cannot be lost even with client clock skew in push ids.
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { db } from '../firebase.js';
import { LIMITS, PayloadTooLargeError, openBytes, sealBytes } from './codec.js';
import { resolveSpace } from './space.js';
import { serverNow } from './time.js';

export const TEXT_NAME = 'content'; // ydoc.getText(TEXT_NAME) holds the file contents
const FLUSH_MS = 150;
const AWARENESS_MS = 200;
const COMPACT_THRESHOLD = 200;
const AWARENESS_STALE_MS = 60_000;

export class CollabProvider {
  /**
   * @param {{space?:object, sid?:string, cid?:string, fid:string, key:CryptoKey, uid:string,
   *          user:{name:string,color:string}, readOnly?:boolean}} opts
   *   `space` (collab/space.js) is preferred; legacy `{sid, cid}` builds channelSpace(sid, cid).
   */
  constructor({ space, sid, cid, fid, key, uid, user, readOnly = false }) {
    this.space = resolveSpace({ space, sid, cid });
    this.sid = this.space.sid; // legacy fields (undefined for codespaces)
    this.cid = this.space.cid;
    this.fid = fid;
    this.key = key;
    this.uid = uid;
    this.readOnly = !!readOnly;
    this.base = this.space.base;

    this.doc = new Y.Doc();
    this.ytext = this.doc.getText(TEXT_NAME);
    this.awareness = new Awareness(this.doc);
    const color = user?.color || '#5b8cff';
    this.awareness.setLocalStateField('user', {
      uid,
      name: user?.name || 'Anonymous',
      color,
      colorLight: color + '33',
    });

    this.status = 'connecting'; // 'connecting' | 'synced' | 'error'
    this.error = null;
    this.warning = null; // non-fatal (e.g. an update that couldn't be decrypted / was too large)
    this.badUpdates = 0;
    this.destroyed = false;

    this._listeners = new Set();
    this._unsubs = [];
    this._queue = Promise.resolve();
    this._known = new Set(); // update keys applied and still present on the server
    this._maxKey = null;
    this._snapBase = { upTo: null, ts: null }; // snapshot currently applied (for CAS)
    this._pending = []; // [{seq, bytes}] local updates not yet taken by a flush
    this._unsent = []; // [{seq, bytes}] local updates whose write hasn't been issued yet (in order)
    this._seq = 0;
    this._presealed = null; // { fromSeq, toSeq, box } — everything unsent, already encrypted
    this._presealing = false;
    this._presealDirty = false;
    this._sendFailed = false;
    this._flushTimer = null;
    this._flushing = null;
    this._awTimer = null;
    this._awLastSent = 0;
    this._awDisconnectSet = false;
    this._compactTimer = null;
    this._compacting = false;
    this._compactDisabled = false;
    this._uidClients = new Map(); // remote uid -> Set<clientID>

    this._onDocUpdate = this._onDocUpdate.bind(this);
    this._onAwarenessUpdate = this._onAwarenessUpdate.bind(this);
    // On tab close/navigation the page can be torn down before any await resumes, so the async
    // seal-then-write path may never issue its write. Local edits are therefore sealed eagerly in
    // the background (_preseal); here we only issue that ready ciphertext, synchronously.
    this._onUnload = () => {
      this._writePresealedNow();
      this.flush();
      remove(ref(db, `${this.base}/awareness/${this.fid}/${this.uid}`)).catch(() => {});
    };
    // Fires before pagehide on close/reload and when the tab is backgrounded (mobile may then
    // kill it without further events): flush early while there's still time.
    this._onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this._writePresealedNow();
        this.flush();
      }
    };
    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwarenessUpdate);
    window.addEventListener('pagehide', this._onUnload);
    window.addEventListener('beforeunload', this._onUnload);
    document.addEventListener('visibilitychange', this._onVisibility);

    this._start();
  }

  // ---------- public API ----------

  /** Subscribe to status/peer changes. Returns unsubscribe. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Remote collaborators currently in this file: [{clientID, uid, name, color}] */
  getPeers() {
    const out = [];
    this.awareness.getStates().forEach((state, clientID) => {
      if (clientID === this.doc.clientID || !state?.user) return;
      out.push({ clientID, ...state.user });
    });
    return out;
  }

  /** Push any buffered local edits now. */
  flush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    return this._flush();
  }

  destroy() {
    if (this.destroyed) return;
    // Send anything still buffered before tearing down (merging is synchronous; the write is async).
    this._flush();
    this.destroyed = true;
    window.removeEventListener('pagehide', this._onUnload);
    window.removeEventListener('beforeunload', this._onUnload);
    document.removeEventListener('visibilitychange', this._onVisibility);
    clearTimeout(this._flushTimer);
    clearTimeout(this._awTimer);
    clearTimeout(this._compactTimer);
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
    const awRef = ref(db, `${this.base}/awareness/${this.fid}/${this.uid}`);
    if (this._awDisconnectSet) onDisconnect(awRef).cancel().catch(() => {});
    remove(awRef).catch(() => {});
    this.doc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);
    this.doc.destroy(); // also destroys the Awareness instance (it listens for doc 'destroy')
    this._listeners.clear();
  }

  // ---------- internals ----------

  _emit() {
    if (this.destroyed) return;
    this._listeners.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    });
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this._emit();
  }

  _enqueue(fn) {
    this._queue = this._queue.then(() => (this.destroyed ? undefined : fn())).catch((err) => {
      console.error('[collab]', err);
      if (!this.destroyed) this._setStatus('error', err.message || String(err));
    });
    return this._queue;
  }

  _start() {
    const snapRef = ref(db, `${this.base}/snapshots/${this.fid}`);
    const updatesRef = ref(db, `${this.base}/updates/${this.fid}`);
    const awRoot = ref(db, `${this.base}/awareness/${this.fid}`);
    const fail = (err) => {
      console.error('[collab] listener', err);
      this._setStatus('error', err?.code === 'PERMISSION_DENIED' ? 'You no longer have access to this workspace.' : err.message);
    };

    let updatesAttached = false;
    const attachUpdates = () => {
      if (updatesAttached || this.destroyed) return;
      updatesAttached = true;
      this._unsubs.push(
        onChildAdded(updatesRef, (s) => {
          const key = s.key;
          const val = s.val();
          this._enqueue(() => this._applyUpdate(key, val));
        }, fail),
        onChildRemoved(updatesRef, (s) => {
          this._known.delete(s.key);
        }, fail),
        // Value events fire after the child_added events for the initial data set, so this
        // marks the point where everything currently stored has been queued.
        onValue(updatesRef, () => {
          this._enqueue(() => {
            if (this.status !== 'synced') this._setStatus('synced');
            this._maybeCompact();
          });
        }, fail, { onlyOnce: true }),
      );
    };

    this._unsubs.push(
      onValue(snapRef, (s) => {
        const val = s.val();
        this._enqueue(async () => {
          await this._applySnapshot(val);
          attachUpdates();
        });
      }, fail),
    );

    const onAw = (s) => {
      if (s.key === this.uid) return;
      const uid = s.key;
      const val = s.val();
      this._applyRemoteAwareness(uid, val);
    };
    this._unsubs.push(
      onChildAdded(awRoot, onAw, () => {}),
      onChildChanged(awRoot, onAw, () => {}),
      onChildRemoved(awRoot, (s) => this._dropRemoteAwareness(s.key), () => {}),
    );

    // Announce ourselves (cursor-less) once listeners are attached.
    this._scheduleAwareness();
  }

  async _applySnapshot(val) {
    if (!val) {
      this._snapBase = { upTo: null, ts: null };
      return;
    }
    try {
      const bytes = await openBytes(this.key, val, this.space.aad.snapshot(this.fid));
      Y.applyUpdate(this.doc, bytes, this);
    } catch (err) {
      console.error('[collab] snapshot decrypt failed', err);
      throw new Error('Could not decrypt this file’s snapshot. It may have been written with a different server key.');
    }
    this._snapBase = { upTo: val.upTo ?? null, ts: val.ts ?? null };
  }

  async _applyUpdate(key, val) {
    try {
      const bytes = await openBytes(this.key, val, this.space.aad.update(this.fid));
      Y.applyUpdate(this.doc, bytes, this);
    } catch (err) {
      console.warn('[collab] skipped undecryptable update', key, err);
      this.badUpdates += 1;
      this.warning = `${this.badUpdates} change${this.badUpdates === 1 ? '' : 's'} could not be decrypted and were skipped.`;
      this._emit();
      return;
    }
    this._known.add(key);
    if (this._maxKey === null || key > this._maxKey) this._maxKey = key;
    if (this.status === 'synced') this._maybeCompact();
  }

  _onDocUpdate(updateBytes, origin) {
    // Updates we applied from the network carry `this` as origin — never echo them back.
    if (origin === this || this.destroyed) return;
    if (this.readOnly) return; // viewers never write content (the rules would reject it anyway)
    if (this._sendFailed) return; // doc already diverged; status is 'error' and the editor is gone
    const entry = { seq: ++this._seq, bytes: updateBytes };
    this._pending.push(entry);
    this._unsent.push(entry);
    this._preseal();
    if (!this._flushTimer) this._flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  // Keep an encrypted copy of *all* unsent updates ready, so an unload can write it synchronously.
  async _preseal() {
    if (this._presealing) {
      this._presealDirty = true;
      return;
    }
    this._presealing = true;
    try {
      do {
        this._presealDirty = false;
        const list = this._unsent.slice();
        if (!list.length || this.destroyed) break;
        const merged = list.length === 1 ? list[0].bytes : Y.mergeUpdates(list.map((e) => e.bytes));
        try {
          const box = await sealBytes(this.key, merged, this.space.aad.update(this.fid), LIMITS.update);
          this._presealed = { fromSeq: list[0].seq, toSeq: list[list.length - 1].seq, box };
        } catch {
          this._presealed = null; // too large etc. — the regular path reports it
        }
      } while (this._presealDirty);
    } finally {
      this._presealing = false;
    }
  }

  // Issue the presealed write synchronously (no await before update()). Covering from the first
  // unsent update keeps the persisted history gap-free; re-sending updates that an in-flight
  // flush also writes is harmless because applying a Yjs update twice is a no-op.
  _writePresealedNow() {
    if (this.destroyed || this._sendFailed || this.readOnly) return;
    const first = this._unsent[0];
    const p = this._presealed;
    if (!first || !p || p.fromSeq > first.seq || p.toSeq < first.seq) return;
    const k = push(ref(db, `${this.base}/updates/${this.fid}`)).key;
    update(ref(db, this.base), {
      [`updates/${this.fid}/${k}`]: { iv: p.box.iv, ct: p.box.ct, uid: this.uid, ts: serverTimestamp() },
    }).catch(() => {});
    this._markIssued(p.toSeq);
  }

  _markIssued(seq) {
    while (this._unsent.length && this._unsent[0].seq <= seq) this._unsent.shift();
    this._pending = this._pending.filter((e) => e.seq > seq);
    if (this._presealed && this._presealed.toSeq <= seq) this._presealed = null;
  }

  _flush() {
    if (this.destroyed || this._sendFailed || this.readOnly || this._pending.length === 0) return this._flushing || Promise.resolve();
    const batch = this._pending;
    this._pending = [];
    const prev = this._flushing || Promise.resolve();
    // Chain writes so they leave in order.
    const p = prev.then(() => this._send(batch)).catch((err) => this._onSendFailed(err));
    this._flushing = p;
    p.finally(() => {
      if (this._flushing === p) this._flushing = null;
    });
    return p;
  }

  // A lost update leaves a hole in this client's Yjs clock: peers (and our own reload) would park
  // every later edit as pending forever. So never keep editing past a failed write — stop and
  // make the user reload from the server state.
  _onSendFailed(err) {
    console.error('[collab] failed to send update', err);
    if (this.destroyed || this._sendFailed) return;
    this._sendFailed = true;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this._pending = [];
    this._unsent = [];
    this._presealed = null;
    const msg = err instanceof PayloadTooLargeError
      ? 'Your last change was too large to sync and was not saved. Reopen the file to continue from the saved version.'
      : err?.code === 'PERMISSION_DENIED' || /permission/i.test(err?.message || '')
        ? 'You no longer have access to this workspace, so your last change was not saved.'
        : `Your last change could not be saved (${err?.message || 'unknown error'}). Reopen the file to continue.`;
    this._setStatus('error', msg);
  }

  async _send(batch) {
    // Anything already issued synchronously by the unload path is skipped.
    const entries = batch.filter((e) => this._unsent.includes(e));
    if (!entries.length) return;
    const aad = this.space.aad.update(this.fid);
    const lastSeq = entries[entries.length - 1].seq;
    let boxes;
    const p = this._presealed;
    if (p && p.fromSeq <= entries[0].seq && p.toSeq === lastSeq && this._unsent[0] === entries[0]) {
      boxes = [p.box];
    } else {
      const merged = entries.length === 1 ? entries[0].bytes : Y.mergeUpdates(entries.map((e) => e.bytes));
      try {
        boxes = [await sealBytes(this.key, merged, aad, LIMITS.update)];
      } catch (err) {
        if (!(err instanceof PayloadTooLargeError) || entries.length < 2) throw err;
        // The merged batch is too big; send each original update (all or nothing below).
        boxes = [];
        for (const e of entries) boxes.push(await sealBytes(this.key, e.bytes, aad, LIMITS.update));
      }
    }
    if (this.destroyed && !this._unsent.length) return;
    const writes = {};
    for (const box of boxes) {
      const k = push(ref(db, `${this.base}/updates/${this.fid}`)).key;
      writes[`updates/${this.fid}/${k}`] = { iv: box.iv, ct: box.ct, uid: this.uid, ts: serverTimestamp() };
    }
    const written = update(ref(db, this.base), writes);
    this._markIssued(lastSeq);
    await written;
    // Best-effort "last edited" stamp, at most once a minute.
    const now = Date.now();
    if (!this._lastTouch || now - this._lastTouch > 60_000) {
      this._lastTouch = now;
      set(ref(db, `${this.base}/files/${this.fid}/updatedAt`), serverTimestamp()).catch(() => {});
    }
  }

  // ---------- compaction ----------

  _maybeCompact() {
    if (this.readOnly) return;
    if (this._compactDisabled || this._compacting || this._compactTimer || this.destroyed) return;
    if (this._known.size <= COMPACT_THRESHOLD) return;
    // Jitter so that several open clients don't all race to compact at once.
    const delay = 500 + Math.random() * 4000;
    this._compactTimer = setTimeout(() => {
      this._compactTimer = null;
      // Capture a consistent view inside the queue (between update applications), then do the
      // slow network work outside it so incoming edits keep flowing.
      this._enqueue(() => {
        if (this._known.size <= COMPACT_THRESHOLD || this.status !== 'synced' || this._compacting) return;
        this._compacting = true;
        const base = { ...this._snapBase };
        let upTo = this._maxKey;
        if (base.upTo && (!upTo || base.upTo > upTo)) upTo = base.upTo;
        const capture = { base, upTo, keys: [...this._known], state: Y.encodeStateAsUpdate(this.doc) };
        this._compact(capture).finally(() => {
          this._compacting = false;
        });
      });
    }, delay);
  }

  async _compact({ base, upTo, keys, state }) {
    try {
      let box;
      try {
        box = await sealBytes(this.key, state, this.space.aad.snapshot(this.fid), LIMITS.snapshot);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          console.warn('[collab] document too large to snapshot; compaction disabled for this file');
          this._compactDisabled = true;
          return;
        }
        throw err;
      }
      if (this.destroyed) return;
      const snapRef = ref(db, `${this.base}/snapshots/${this.fid}`);
      const ts = serverNow();
      const result = await runTransaction(
        snapRef,
        (cur) => {
          // Compare-and-swap: only replace the snapshot we have actually applied, so we never
          // overwrite state contributed by a concurrent compactor.
          if ((cur?.upTo ?? null) !== base.upTo || (cur?.ts ?? null) !== base.ts) return undefined;
          return { iv: box.iv, ct: box.ct, upTo, ts };
        },
        { applyLocally: false },
      );
      if (!result.committed) return; // someone else compacted first; we'll pick up their snapshot
      // Delete exactly the updates folded into the snapshot (all have key <= upTo).
      const updatesRef = ref(db, `${this.base}/updates/${this.fid}`);
      for (let i = 0; i < keys.length; i += 400) {
        const chunk = {};
        for (const k of keys.slice(i, i + 400)) chunk[k] = null;
        await update(updatesRef, chunk);
      }
    } catch (err) {
      // Compaction is an optimisation; never fail the editor because of it.
      console.warn('[collab] compaction skipped', err);
    }
  }

  // ---------- awareness ----------

  _onAwarenessUpdate({ added, updated, removed }, origin) {
    if (origin !== 'local' || this.destroyed) {
      if (origin !== 'local') this._emit();
      return;
    }
    const me = this.doc.clientID;
    if (added.includes(me) || updated.includes(me) || removed.includes(me)) this._scheduleAwareness();
  }

  _scheduleAwareness() {
    if (this._awTimer || this.destroyed) return;
    const wait = Math.max(0, AWARENESS_MS - (Date.now() - this._awLastSent));
    this._awTimer = setTimeout(() => {
      this._awTimer = null;
      this._awLastSent = Date.now();
      this._sendAwareness().catch((err) => console.warn('[collab] awareness send failed', err));
    }, wait);
  }

  async _sendAwareness() {
    if (this.destroyed || !this.awareness.getLocalState()) return;
    const bytes = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    const box = await sealBytes(this.key, bytes, this.space.aad.awareness(this.fid, this.uid), LIMITS.awareness);
    if (this.destroyed) return;
    const awRef = ref(db, `${this.base}/awareness/${this.fid}/${this.uid}`);
    if (!this._awDisconnectSet) {
      this._awDisconnectSet = true;
      onDisconnect(awRef).remove().catch(() => {
        this._awDisconnectSet = false;
      });
    }
    await set(awRef, { iv: box.iv, ct: box.ct, ts: serverTimestamp() });
  }

  async _applyRemoteAwareness(uid, val) {
    if (!val?.ct) return;
    if (typeof val.ts === 'number' && serverNow() - val.ts > AWARENESS_STALE_MS) return;
    try {
      const bytes = await openBytes(this.key, val, this.space.aad.awareness(this.fid, uid));
      if (this.destroyed) return;
      applyAwarenessUpdate(this.awareness, bytes, 'remote');
      // Remember which Yjs client ids belong to this uid so we can drop them on removal.
      // Only trust states whose embedded uid matches the (AAD-bound) storage location.
      const ids = this._uidClients.get(uid) || new Set();
      this.awareness.getStates().forEach((state, clientID) => {
        if (clientID === this.doc.clientID) return;
        if (state?.user?.uid === uid) ids.add(clientID);
      });
      this._uidClients.set(uid, ids);
      this._emit();
    } catch (err) {
      console.warn('[collab] awareness decrypt failed for', uid, err);
    }
  }

  _dropRemoteAwareness(uid) {
    const ids = this._uidClients.get(uid);
    if (!ids) return;
    this._uidClients.delete(uid);
    removeAwarenessStates(this.awareness, [...ids], 'remote');
    this._emit();
  }
}
