// UNVERIFIED skeleton: never executed. Needs chromium args --use-fake-device-for-media-stream
// --use-fake-ui-for-media-stream (set per-context via launchOptions in a project before running).
import { test, expect, createServer, makeInvite, joinServer, send } from './fixtures.mjs';
import { test as base } from '@playwright/test';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['camera', 'microphone'] });

test('mention raises bell badge for another user', async ({ users }) => {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Hub');
  await joinServer(bob, await makeInvite(alice), 'Hub');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await send(alice, '@Bob ping');
  await expect(bob.getByTestId('notif-badge')).toBeVisible({ timeout: 20_000 });
});

test('voice channel call: two users see a remote video track', async ({ users }) => {
  test.fixme(true, 'selectors for creating/joining a voice channel not verified');
});
