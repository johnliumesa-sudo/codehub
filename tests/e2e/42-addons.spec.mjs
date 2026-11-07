// Add-ons in the real UI: the builder with its live preview, publishing, personal install and the
// bridge (context, messages, composer, confirmed send, encrypted storage, navigation stop), admin
// seeding of the example add-ons, reports, and server add-ons with member consent and pinned updates.
import { test, expect, createServer, makeInvite, joinServer, send, adminGet, adminPut, uid } from './fixtures.mjs';

// A test add-on that exercises every bridge call and writes the results into its own page.
const TEST_ADDON = `<!doctype html>
<html><body>
<p id="ctx">waiting</p>
<p id="out">idle</p>
<button id="read">Read</button>
<button id="ins">Insert</button>
<button id="send">Send</button>
<button id="save">Save</button>
<button id="load">Load</button>
<button id="leave">Leave</button>
<script>
var out = function (t) { document.getElementById('out').textContent = t; };
codehub.ready().then(function (i) {
  document.getElementById('ctx').textContent = 'ctx:' + i.context.kind + ':' + i.context.name + ':' + i.context.me.name + ':' + i.perms.join(',') + ':' + i.theme.mode;
});
document.getElementById('read').onclick = function () {
  codehub.getMessages(5).then(function (m) { out('msgs:' + m.map(function (x) { return x.author + '=' + x.text; }).join('|')); }, function (e) { out('err:' + e.code); });
};
document.getElementById('ins').onclick = function () { codehub.insertText('typed by the add-on'); };
document.getElementById('send').onclick = function () {
  codehub.sendMessage('sent by the add-on').then(function () { out('sent'); }, function (e) { out('err:' + e.code); });
};
document.getElementById('save').onclick = function () {
  codehub.storage.set('k', { secret: 'kept-in-storage' }).then(function () { out('saved'); }, function (e) { out('err:' + e.code); });
};
document.getElementById('load').onclick = function () {
  codehub.storage.get('k').then(function (v) { out('loaded:' + (v && v.secret)); }, function (e) { out('err:' + e.code); });
};
document.getElementById('leave').onclick = function () { location.href = 'about:blank#gone'; };
</script>
</body></html>`;

async function openPalette(page, title) {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
}

async function fillBuilder(page, { name, version = '1.0.0', perms = [], code }) {
  const hub = page.getByRole('dialog', { name: 'Add-ons' });
  await hub.getByLabel('Name', { exact: true }).fill(name);
  await hub.getByLabel('Version', { exact: true }).fill(version);
  for (const p of perms) await hub.getByRole('checkbox', { name: new RegExp(`^${p}`) }).check();
  const editor = hub.locator('.ad-editor .cm-content');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill(code);
  return hub;
}

async function addonId(name) {
  const all = (await adminGet('pub/addons')) || {};
  return Object.keys(all).find((k) => all[k].name === name);
}

test('builder preview, publish, personal install and every bridge call', async ({ users }) => {
  test.setTimeout(240_000);
  const alice = await users('alice');
  await createServer(alice, 'Addon Lab');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await send(alice, 'hello addon world');

  // Builder with live preview (mock bridge, sample data).
  await openPalette(alice, 'Create an add-on');
  const hub = await fillBuilder(alice, {
    name: 'Echo pad',
    perms: ['Read messages', 'Write in your message box', 'Send messages as you', 'Store its own data'],
    code: TEST_ADDON,
  });
  const preview = alice.frameLocator('.ad-preview-frame iframe');
  await expect(preview.locator('#ctx')).toHaveText(/^ctx:preview:Preview:Alice:readMessages,composer,send,storage:(dark|light)$/, { timeout: 20_000 });
  await preview.locator('#read').click();
  await expect(preview.locator('#out')).toContainText('msgs:');
  await expect(preview.locator('#out')).toContainText('Linus=Reminder: freeze starts Friday');
  await preview.locator('#send').click();
  await expect(hub.getByRole('log', { name: 'Preview console' })).toContainText('sendMessage → “sent by the add-on” (preview: not sent');

  // Publish -> details -> install with the permissions shown first.
  await hub.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(hub.getByRole('heading', { name: 'Echo pad' })).toBeVisible();
  await expect(hub.getByText('Permissions it asks for')).toBeVisible();
  await hub.getByRole('button', { name: 'Install', exact: true }).click();
  const install = alice.getByRole('dialog', { name: 'Install Echo pad for you' });
  await expect(install.getByRole('checkbox', { name: /Send messages as you/ })).toBeChecked();
  await install.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(hub.getByText('Installed', { exact: true })).toBeVisible();
  const id = await addonId('Echo pad');
  const me = await uid(alice);
  const pub = await adminGet(`pub/addons/${id}`);
  expect(pub.perms).toBe('readMessages,composer,send,storage');
  expect((await adminGet(`pub/addonCode/${id}`)).sha).toBe(pub.sha);
  expect((await adminGet(`udata/${me}/addons/${id}`)).sha).toBe(pub.sha);
  expect((await adminGet(`udata/${me}/addonPin/${id}`)).c0).toContain('codehub.ready');
  await alice.keyboard.press('Escape');
  await expect(hub).toHaveCount(0);

  // Run it from the chat header's Add-ons panel.
  await alice.getByRole('button', { name: 'Add-ons', exact: true }).click();
  const panel = alice.getByRole('complementary', { name: 'Add-ons' });
  await panel.getByRole('button', { name: 'Open Echo pad' }).click();
  const frame = alice.frameLocator('iframe[title="Echo pad (add-on)"]');
  await expect(frame.locator('#ctx')).toHaveText(/^ctx:channel:general:Alice:readMessages,composer,send,storage:/, { timeout: 20_000 });
  await frame.locator('#read').click();
  await expect(frame.locator('#out')).toHaveText('msgs:Alice=hello addon world');

  await frame.locator('#ins').click();
  await expect(alice.locator('textarea[aria-label^="Message"]')).toHaveValue(/typed by the add-on/);
  await alice.locator('textarea[aria-label^="Message"]').fill('');

  // sendMessage asks first; declining rejects the call, accepting posts with a "via" badge.
  await frame.locator('#send').click();
  const ask = alice.getByRole('alertdialog', { name: 'Send a message for Echo pad?' });
  await expect(ask).toContainText('sent by the add-on');
  await ask.getByRole('button', { name: 'Don’t send' }).click();
  await expect(frame.locator('#out')).toHaveText('err:CANCELLED');
  await alice.waitForTimeout(3100); // one send every 3 s
  await frame.locator('#send').click();
  await alice.getByRole('alertdialog', { name: 'Send a message for Echo pad?' }).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(frame.locator('#out')).toHaveText('sent');
  const sent = alice.locator('.msg', { hasText: 'sent by the add-on' });
  await expect(sent.locator('.ad-via')).toHaveText('via 🧩 Echo pad');

  // Storage is sealed with the vault key and survives a reload.
  await frame.locator('#save').click();
  await expect(frame.locator('#out')).toHaveText('saved');
  await expect.poll(async () => (await adminGet(`udata/${me}/addonStore/${id}`))?.n || 0).toBeGreaterThan(0);
  const stored = await adminGet(`udata/${me}/addonStore/${id}`);
  expect(stored.iv).toBeTruthy();
  expect(JSON.stringify(stored)).not.toContain('kept-in-storage');
  await alice.reload();
  await alice.getByRole('button', { name: 'Add-ons', exact: true }).click();
  await alice.getByRole('complementary', { name: 'Add-ons' }).getByRole('button', { name: 'Open Echo pad' }).click();
  await frame.locator('#load').click();
  await expect(frame.locator('#out')).toHaveText('loaded:kept-in-storage');

  // A frame that navigates itself away is stopped.
  await frame.locator('#leave').click();
  await expect(alice.getByRole('complementary', { name: 'Add-ons' }).getByRole('alert')).toContainText('tried to load another page');

  // Settings tab lists it; uninstall removes install, pin and data.
  await openPalette(alice, 'Open settings');
  await alice.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Add-on apps' }).click();
  const settings = alice.getByRole('dialog', { name: 'Settings' });
  const row = settings.getByRole('region', { name: 'Installed for you' }).locator('.ad-row', { hasText: 'Echo pad' });
  await expect(row).toContainText('Send messages as you');
  await expect(settings.getByRole('region', { name: 'Stored data' })).toContainText('Echo pad');
  await row.getByRole('button', { name: 'Uninstall' }).click();
  await row.getByRole('button', { name: 'Uninstall and delete its data?' }).click();
  await expect(settings.locator('.ad-row', { hasText: 'Echo pad' })).toHaveCount(0);
  expect(await adminGet(`udata/${me}/addonPin/${id}`)).toBeNull();
  expect(await adminGet(`udata/${me}/addonStore/${id}`)).toBeNull();
});

test('admin seeds the examples; users install, report; admins remove', async ({ users }) => {
  test.setTimeout(240_000);
  const alice = await users('alice');
  const aliceUid = await uid(alice);
  await adminPut(`admins/${aliceUid}`, { at: 1 });
  await adminPut(`adminBadges/${aliceUid}`, true);
  await alice.getByRole('button', { name: 'Open admin panel' }).click();
  const adminPanel = alice.getByRole('dialog', { name: 'Admin panel' });
  await adminPanel.getByRole('button', { name: 'Add-ons', exact: true }).click();
  const examples = adminPanel.locator('.ad-row', { hasText: 'Pomodoro timer' }).first();
  await examples.getByRole('button', { name: 'Publish to directory' }).click();
  await expect(examples.getByText('Published')).toBeVisible();
  const cloud = adminPanel.locator('.ad-row', { hasText: 'Channel word cloud' }).first();
  await cloud.getByRole('button', { name: 'Publish to directory' }).click();
  await expect(cloud.getByText('Published')).toBeVisible();
  await alice.getByRole('button', { name: 'Close admin panel' }).click();

  // Bob installs the Pomodoro timer for himself; it keeps its state in storage.
  const bob = await users('bob');
  await createServer(bob, 'Bob Base');
  await bob.getByRole('button', { name: /general/ }).first().click();
  await openPalette(bob, 'Browse add-ons');
  const hub = bob.getByRole('dialog', { name: 'Add-ons' });
  await hub.getByLabel('Search add-ons').fill('pomodoro');
  await hub.getByRole('button', { name: /Pomodoro timer, version 1\.0\.0/ }).click();
  await expect(hub.getByText('Store its own data')).toBeVisible();
  await expect(hub.locator('.ad-chip.admin')).toHaveText('app admin');
  await hub.getByRole('button', { name: 'Install', exact: true }).click();
  await bob.getByRole('dialog', { name: /Install Pomodoro timer/ }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(hub.getByText('Installed', { exact: true })).toBeVisible();

  // Report the word cloud (filed as a catalog item with target addon:{id}).
  await hub.getByRole('button', { name: 'Back to the directory' }).click();
  await hub.getByRole('button', { name: /Channel word cloud/ }).click();
  await hub.getByRole('button', { name: 'Report' }).click();
  const report = bob.getByRole('dialog', { name: 'Report “Channel word cloud”' });
  await report.getByRole('radio', { name: 'Spam' }).check();
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(bob.getByRole('dialog', { name: 'Report sent' })).toBeVisible();
  await bob.getByRole('dialog', { name: 'Report sent' }).getByRole('button', { name: 'Done' }).click();
  await bob.keyboard.press('Escape');

  await bob.getByRole('button', { name: 'Add-ons', exact: true }).click();
  await bob.getByRole('complementary', { name: 'Add-ons' }).getByRole('button', { name: 'Open Pomodoro timer' }).click();
  const timer = bob.frameLocator('iframe[title="Pomodoro timer (add-on)"]');
  await expect(timer.locator('#time')).toHaveText('25:00');
  await expect(timer.locator('#meta')).toContainText('Sessions completed: 0');
  await timer.getByRole('button', { name: 'Short break' }).click();
  await expect(timer.locator('#time')).toHaveText('05:00');
  await bob.waitForTimeout(800); // storage is written after a short debounce
  await bob.getByRole('button', { name: 'Back to the add-on list' }).click();
  await bob.getByRole('complementary', { name: 'Add-ons' }).getByRole('button', { name: 'Open Pomodoro timer' }).click();
  await expect(timer.getByRole('button', { name: 'Short break' })).toHaveAttribute('aria-pressed', 'true');
  await expect(timer.locator('#time')).toHaveText('05:00');

  // The admin sees the report as an add-on and removes it from the directory.
  await alice.getByRole('button', { name: 'Open admin panel' }).click();
  await adminPanel.getByRole('button', { name: 'Reports', exact: true }).click();
  const card = adminPanel.locator('.adm-report', { hasText: 'Channel word cloud' });
  await expect(card.locator('.adm-pill.kind')).toHaveText('Add-on');
  await card.getByRole('button', { name: 'Remove add-on' }).click();
  await card.getByRole('button', { name: 'Remove for everyone?' }).click();
  await expect(adminPanel.locator('.adm-report', { hasText: 'Channel word cloud' })).toHaveCount(0);
  const left = Object.values((await adminGet('pub/addons')) || {}).map((a) => a.name);
  expect(left).toContain('Pomodoro timer');
  expect(left).not.toContain('Channel word cloud');
});

test('server add-on: manager installs, members consent, updates stay pinned until reviewed', async ({ users }) => {
  test.setTimeout(240_000);
  const alice = await users('alice');
  await createServer(alice, 'Team');
  const link = await makeInvite(alice);
  const bob = await users('bob');
  await joinServer(bob, link, 'Team');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await send(alice, 'deploy deploy deploy pipeline');

  // Alice publishes a small add-on and installs it on the server from server settings.
  await openPalette(alice, 'Create an add-on');
  const code = (marker) => `<!doctype html><p id="v">${marker}</p><p id="w">…</p><script>codehub.ready().then(function () { return codehub.getMessages(20); }).then(function (m) { document.getElementById('w').textContent = m.map(function (x) { return x.text; }).join(' / '); }, function (e) { document.getElementById('w').textContent = 'err:' + e.code; });</script>`;
  const hub = await fillBuilder(alice, { name: 'Team board', perms: ['Read messages'], code: code('version one') });
  await hub.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(hub.getByRole('heading', { name: 'Team board' })).toBeVisible();
  await alice.keyboard.press('Escape');

  await alice.locator('.ly-server-title').click();
  await alice.getByRole('menuitem', { name: /Server settings/ }).click();
  await alice.getByRole('tab', { name: /Add-ons/ }).click();
  await alice.getByRole('button', { name: 'Install an add-on' }).click();
  await alice.getByRole('button', { name: /Team board, version 1\.0\.0/ }).click();
  await alice.getByRole('button', { name: 'Install on this server' }).click();
  await alice.getByRole('dialog', { name: /Install Team board on/ }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(alice.getByText('Installed on this server')).toBeVisible();
  await alice.keyboard.press('Escape');

  // Bob (a plain member) sees its header button, consents once, and it reads the channel.
  await bob.getByRole('button', { name: /general/ }).first().click();
  await bob.getByRole('button', { name: 'Team board (add-on)' }).click();
  const consent = bob.getByRole('complementary', { name: 'Team board' });
  await expect(consent).toContainText('A server manager installed this add-on');
  await expect(consent).toContainText('Read messages');
  await consent.getByRole('button', { name: 'Allow and open' }).click();
  const frame = bob.frameLocator('iframe[title="Team board (add-on)"]');
  await expect(frame.locator('#v')).toHaveText('version one', { timeout: 20_000 });
  await expect(frame.locator('#w')).toContainText('deploy deploy deploy pipeline');
  const id = await addonId('Team board');
  expect((await adminGet(`udata/${await uid(bob)}/addonConsent/`))).toBeTruthy();
  // Members cannot manage server add-ons.
  await bob.locator('.ly-server-title').click();
  await bob.getByRole('menuitem', { name: /Server settings/ }).click();
  await expect(bob.getByRole('tab', { name: /Add-ons/ })).toHaveCount(0);
  await bob.keyboard.press('Escape');

  // The publisher ships v1.1.0: members keep the pinned v1 until a manager reviews the update.
  await openPalette(alice, 'Create an add-on');
  const hub2 = alice.getByRole('dialog', { name: 'Add-ons' });
  await hub2.getByRole('tab', { name: 'Your add-ons' }).click();
  await hub2.getByRole('button', { name: 'Edit Team board' }).click();
  await expect(hub2.getByLabel('Name', { exact: true })).toHaveValue('Team board');
  await hub2.locator('.ad-editor .cm-content').fill(code('version two'));
  await hub2.getByRole('button', { name: 'Publish update' }).click();
  await expect(hub2.getByText(/Raise the version above 1\.0\.0/)).toBeVisible();
  await hub2.getByLabel('Version', { exact: true }).fill('1.1.0');
  await hub2.getByRole('button', { name: 'Publish update' }).click();
  await expect(hub2.getByText('v1.1.0', { exact: false }).first()).toBeVisible();
  await alice.keyboard.press('Escape');
  expect((await adminGet(`pub/addons/${id}`)).version).toBe('1.1.0');

  await bob.getByRole('button', { name: 'Team board (add-on)' }).click(); // close
  await bob.getByRole('button', { name: 'Team board (add-on)' }).click(); // reopen
  await expect(frame.locator('#v')).toHaveText('version one', { timeout: 20_000 });

  await alice.locator('.ly-server-title').click();
  await alice.getByRole('menuitem', { name: /Server settings/ }).click();
  await alice.getByRole('tab', { name: /Add-ons/ }).click();
  const row = alice.locator('.ad-row', { hasText: 'Team board' });
  await expect(row).toContainText('update: v1.1.0');
  await row.getByRole('button', { name: 'Review update' }).click();
  const review = alice.getByRole('dialog', { name: 'Update Team board' });
  await review.getByText(/Code changes/).click();
  await expect(review.locator('.ad-diff-body .add')).toContainText('version two');
  await review.getByRole('button', { name: 'Accept update' }).click();
  await expect(row).not.toContainText('update:');
  await alice.keyboard.press('Escape');

  await bob.getByRole('button', { name: 'Team board (add-on)' }).click();
  await bob.getByRole('button', { name: 'Team board (add-on)' }).click();
  await expect(frame.locator('#v')).toHaveText('version two', { timeout: 20_000 });
});
