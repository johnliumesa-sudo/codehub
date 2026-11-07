// Port blocks for the local test emulators and Vite, so several checkouts can run tests at once.
// CODEHUB_PORT_BASE picks the block (default 9000 = the historical ports):
//   base 9000: database 9000, auth 9099, vite (e2e) 5199, emulator hub 4400, logging 4500
//   base B:    database B,    auth B+99, vite (e2e) B+80, emulator hub B+50, logging B+51   (B = 9100, 9200, …)
// writeTestConfig(base) writes firebase.test-<base>.json (gitignored) next to firebase.json; the
// runners pass it to the Firebase CLI with --config.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_BASE = 9000;

export function portBase(env = process.env) {
  const raw = env.CODEHUB_PORT_BASE;
  if (raw === undefined || raw === '') return DEFAULT_BASE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65400) throw new Error(`CODEHUB_PORT_BASE must be an integer port between 1024 and 65400 (got ${raw})`);
  return n;
}

export function portsFor(base = portBase()) {
  if (base === DEFAULT_BASE) return { base, database: 9000, auth: 9099, vite: 5199, hub: 4400, logging: 4500 };
  return { base, database: base, auth: base + 99, vite: base + 80, hub: base + 50, logging: base + 51 };
}

export const testConfigName = (base) => `firebase.test-${base}.json`;

/** Write firebase.test-<base>.json (same as firebase.json with this block's emulator ports). Returns its file name. */
export function writeTestConfig(base = portBase()) {
  const p = portsFor(base);
  const cfg = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
  cfg.emulators = {
    ...(cfg.emulators || {}),
    auth: { port: p.auth },
    database: { port: p.database },
    hub: { port: p.hub },
    logging: { port: p.logging },
    ui: { enabled: false },
  };
  const name = testConfigName(base);
  writeFileSync(new URL(`../${name}`, import.meta.url), `${JSON.stringify(cfg, null, 2)}\n`);
  return name;
}
