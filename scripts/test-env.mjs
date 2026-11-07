#!/usr/bin/env node
// Test runner bound to one port block (scripts/test-ports.mjs, CODEHUB_PORT_BASE):
//   node scripts/test-env.mjs rules [test files…]   rules tests on the Database emulator (default: tests/rules/*.test.mjs)
//   node scripts/test-env.mjs e2e [playwright args…] Playwright browser tests (emulators + Vite on this block)
//   node scripts/test-env.mjs ports                  print this block's ports
//   node scripts/test-env.mjs kill                   stop whatever still listens on this block's ports
// Only processes on this block's ports are ever stopped, so parallel checkouts don't disturb each other.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, portBase, portsFor, writeTestConfig } from './test-ports.mjs';

const bin = (name) => {
  const local = join(ROOT, 'node_modules', '.bin', name);
  return existsSync(local) ? local : name;
};

/** PIDs listening on a TCP port (macOS/Linux with lsof; empty if lsof is missing). */
function listeners(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\s+/).filter(Boolean).map(Number).filter((n) => n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

export function freePorts(p = portsFor()) {
  const pids = new Set([p.database, p.auth, p.hub, p.logging, p.vite].flatMap(listeners));
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return pids.size;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const base = portBase();
  const p = portsFor(base);
  const env = { CODEHUB_PORT_BASE: String(base) };
  if (mode === 'ports') {
    console.log(JSON.stringify(p));
    return 0;
  }
  if (mode === 'kill') {
    console.log(`stopped ${freePorts(p)} process(es) on port block ${base}`);
    return 0;
  }
  if (mode === 'rules') {
    const config = writeTestConfig(base);
    if (freePorts(p)) await new Promise((r) => setTimeout(r, 1500));
    const files = rest.length ? rest : ['tests/rules/*.test.mjs'];
    return run(bin('firebase'), [
      'emulators:exec', '--config', config, '--only', 'database', '--project', 'demo-codehub',
      `node --test --test-concurrency=1 ${files.join(' ')}`,
    ], env);
  }
  if (mode === 'e2e') {
    writeTestConfig(base);
    if (freePorts(p)) await new Promise((r) => setTimeout(r, 1500));
    const code = await run(bin('playwright'), ['test', '-c', 'tests/e2e/playwright.config.mjs', ...rest], env);
    freePorts(p); // Playwright does not reap the Java emulator child
    return code;
  }
  console.error('usage: node scripts/test-env.mjs rules [files…] | e2e [playwright args…] | ports | kill');
  return 2;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
