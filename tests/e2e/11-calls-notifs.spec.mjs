import { test, expect, createServer, makeInvite, joinServer, send } from './fixtures.mjs';


test('mention raises bell badge for another user', async ({ users }) => {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Hub');
  await joinServer(bob, await makeInvite(alice), 'Hub');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await send(alice, '@Bob ping');
  await expect(bob.getByTestId('notif-badge')).toBeVisible({ timeout: 20_000 });
});

// Real calls (DM, group, voice channel) are covered in 30-calls.spec.mjs.
