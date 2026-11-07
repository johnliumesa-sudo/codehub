// One atomic multi-path update plus "side" paths: leftovers (call slots, signals, last-post markers,
// poll votes, feature data) that the current rules let us delete in the same write as their parent.
//
// The rules are published by hand after a deploy, so for a while the site can run against older
// rules that refuse some side paths. RTDB rejects a whole multi-path update if any one path is
// refused, which would make "delete server/channel/group" fail outright. So if the combined write is
// refused, retry the core write alone and remove each side path on its own (best effort) before it
// (paths only the owner may clear while the parent exists, e.g. emotes) and after it (paths the
// rules free up once the parent is gone).
//
// `deps` exists for tests; the app uses the Firebase SDK.

const isDenied = (e) => /permission[_ ]denied/i.test(`${e?.code || ''} ${e?.message || ''}`);

async function sdkDeps() {
  return (await import('./cleanupSdk.js')).sdkDeps;
}

export async function updateWithCleanup(core, sidePaths = [], deps) {
  const d = deps || (await sdkDeps());
  const side = Object.fromEntries(sidePaths.map((p) => [p, null]));
  try {
    await d.update({ ...core, ...side });
    return { fallback: false };
  } catch (e) {
    if (!sidePaths.length || !isDenied(e)) throw e;
  }
  const sweep = () => Promise.all(sidePaths.map((p) => Promise.resolve().then(() => d.remove(p)).catch(() => {})));
  await sweep();
  await d.update(core);
  await sweep();
  return { fallback: true };
}
