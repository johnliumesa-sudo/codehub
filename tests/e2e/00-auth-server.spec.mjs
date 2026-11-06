import { test, expect, createServer, makeInvite, joinServer, send, adminGet } from './fixtures.mjs';
import { NS, DB } from './global-setup.mjs';

test('rules are enforced in the namespace the browser uses', async ({ users }) => {
  const alice = await users('alice');
  const status = await alice.evaluate(async (ns) => (await fetch(`http://127.0.0.1:9000/users.json?ns=${ns}`)).status, NS);
  expect(status).toBe(401);
});

test('sign-up, server create, invite, join, message', async ({ users }) => {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Hub');
  const link = await makeInvite(alice);
  expect(link).toContain('#/join/');
  await joinServer(bob, link, 'Hub');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await bob.getByRole('button', { name: /general/ }).first().click();
  await send(alice, 'hello bob');
  await expect(bob.getByText('hello bob')).toBeVisible();
  // E2EE: no plaintext in the DB
  const msgs = JSON.stringify(await adminGet('messages'));
  expect(msgs).not.toContain('hello bob');
});
