import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// The app connects to the namespace derived from firebase.js databaseURL (codehub-dc9a4-default-rtdb),
// NOT the emulator project's default namespace, so load the real rules into that namespace explicitly.
export const NS = 'codehub-dc9a4-default-rtdb';
export const DB = 'http://127.0.0.1:9000';
export const RULES = fileURLToPath(new URL('../../database.rules.json', import.meta.url));

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`timed out waiting for ${url}`);
}

export default async function globalSetup() {
  await waitFor('http://127.0.0.1:9099/');
  const rules = readFileSync(RULES, 'utf8');
  const r = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules,
  });
  if (!r.ok) throw new Error(`loading rules into ${NS} failed: ${r.status} ${await r.text()}`);
  // sanity: an unauthenticated read of a protected path must be denied
  const d = await fetch(`${DB}/users.json?ns=${NS}`);
  if (d.status !== 401) throw new Error(`rules not enforced on ${NS}: unauthenticated read gave ${d.status}`);
  // Playwright does not reap the java emulator child; stop the emulators afterwards.
  return () => { try { execSync('pkill -f firebase-database-emulator; pkill -f "firebase emulators:start"; true'); } catch {} };
}
