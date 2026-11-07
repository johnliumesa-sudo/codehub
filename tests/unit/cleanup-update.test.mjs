// updateWithCleanup: deletes must keep working when the published rules are older than the client
// and refuse some leftover ("side") paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateWithCleanup } from '../../src/lib/cleanupUpdate.js';

/** Fake RTDB: `allowed(path)` decides each path; a multi-path update is all-or-nothing. */
function fakeDb(allowed) {
  const log = [];
  const denied = () => Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'PERMISSION_DENIED' });
  return {
    log,
    update: async (patch) => {
      const paths = Object.keys(patch);
      if (!paths.every(allowed)) throw denied();
      log.push(['update', paths.sort()]);
    },
    remove: async (path) => {
      if (!allowed(path)) throw denied();
      log.push(['remove', path]);
    },
  };
}

const core = { 'servers/s1': null, 'messages/s1': null };
const side = ['vcalls/s1', 'emotes/s1'];

test('new rules: one combined write, no fallback', async () => {
  const db = fakeDb(() => true);
  const r = await updateWithCleanup(core, side, db);
  assert.equal(r.fallback, false);
  assert.deepEqual(db.log, [['update', ['emotes/s1', 'messages/s1', 'servers/s1', 'vcalls/s1']]]);
});

test('old rules refuse a side path: core still deleted, allowed side paths removed', async () => {
  const db = fakeDb((p) => p !== 'vcalls/s1');
  const r = await updateWithCleanup(core, side, db);
  assert.equal(r.fallback, true);
  assert.deepEqual(db.log.filter(([op]) => op === 'update'), [['update', ['messages/s1', 'servers/s1']]]);
  assert.ok(db.log.some(([op, p]) => op === 'remove' && p === 'emotes/s1'));
  assert.ok(!db.log.some(([, p]) => p === 'vcalls/s1'));
});

test('core refused: the error still reaches the caller', async () => {
  const db = fakeDb((p) => p !== 'servers/s1');
  await assert.rejects(updateWithCleanup(core, side, db), /PERMISSION_DENIED/);
});

test('non-permission errors are not swallowed', async () => {
  const db = { update: async () => { throw new Error('network down'); }, remove: async () => {} };
  await assert.rejects(updateWithCleanup(core, side, db), /network down/);
});
