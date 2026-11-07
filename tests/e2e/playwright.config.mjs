import { defineConfig } from '@playwright/test';
import { portsFor, testConfigName, writeTestConfig } from '../../scripts/test-ports.mjs';

// Multi-user E2E: Auth + Database emulators (project demo-codehub) + vite with VITE_EMULATORS=1, on the
// port block chosen by CODEHUB_PORT_BASE (default: database 9000, auth 9099, vite 5199; see
// scripts/test-ports.mjs). Needs Java on PATH for the database emulator. Never touches the live project.
const P = portsFor();
writeTestConfig(P.base); // firebase.test-<base>.json, also when Playwright is started directly

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  globalSetup: './global-setup.mjs',
  use: { baseURL: `http://127.0.0.1:${P.vite}`, trace: 'retain-on-failure', permissions: ['clipboard-read', 'clipboard-write'] },
  webServer: [
    {
      command: `npx firebase emulators:start --config ${testConfigName(P.base)} --only auth,database --project demo-codehub`,
      cwd: '../..',
      port: P.database,
      reuseExistingServer: !!process.env.E2E_REUSE,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${P.vite} --strictPort --host 127.0.0.1`,
      cwd: '../..',
      env: { VITE_EMULATORS: '1', VITE_EMU_DB_PORT: String(P.database), VITE_EMU_AUTH_PORT: String(P.auth) },
      url: `http://127.0.0.1:${P.vite}`,
      reuseExistingServer: !!process.env.E2E_REUSE,
      timeout: 120_000,
    },
  ],
});
