import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { portsFor } from '../../scripts/test-ports.mjs';

// The app connects to the namespace derived from firebase.js databaseURL (codehub-dc9a4-default-rtdb),
// NOT the emulator project's default namespace, so load the real rules into that namespace explicitly.
export const NS = 'codehub-dc9a4-default-rtdb';
export const PORTS = portsFor(); // CODEHUB_PORT_BASE block (scripts/test-ports.mjs)
export const DB = `http://127.0.0.1:${PORTS.database}`;
export const RULES = fileURLToPath(new URL('../../database.rules.json', import.meta.url));

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`timed out waiting for ${url}`);
}

export default async function globalSetup() {
  await waitFor(`http://127.0.0.1:${PORTS.auth}/`);
  const rules = readFileSync(RULES, 'utf8');
  const r = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules,
  });
  if (!r.ok) throw new Error(`loading rules into ${NS} failed: ${r.status} ${await r.text()}`);
  // sanity: an unauthenticated read of a protected path must be denied
  const d = await fetch(`${DB}/users.json?ns=${NS}`);
  if (d.status !== 401) throw new Error(`rules not enforced on ${NS}: unauthenticated read gave ${d.status}`);
  // Playwright does not reap the java emulator child; stop this port block's emulators afterwards
  // (only ours: other checkouts may be running tests on other blocks).
  return () => {
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/test-env.mjs', import.meta.url)), 'kill'], { stdio: 'ignore', env: process.env });
    } catch {}
  };
}
