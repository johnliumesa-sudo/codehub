import { defineConfig } from '@playwright/test';

// Multi-user E2E: Auth + Database emulators (project demo-codehub) + vite on :5199 with VITE_EMULATORS=1.
// Needs Java on PATH for the database emulator. Never touches the live project.
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
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'retain-on-failure', permissions: ['clipboard-read', 'clipboard-write'] },
  webServer: [
    {
      command: 'npx firebase emulators:start --only auth,database --project demo-codehub',
      cwd: '../..',
      port: 9000,
      reuseExistingServer: !!process.env.E2E_REUSE,
      timeout: 120_000,
    },
    {
      command: 'npx vite --port 5199 --strictPort --host 127.0.0.1',
      cwd: '../..',
      env: { VITE_EMULATORS: '1' },
      url: 'http://127.0.0.1:5199',
      reuseExistingServer: !!process.env.E2E_REUSE,
      timeout: 120_000,
    },
  ],
});
