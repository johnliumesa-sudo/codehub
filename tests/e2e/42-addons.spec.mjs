// Add-ons in the real UI: the builder with its live preview, publishing, personal install and the
// bridge (context, messages, composer, confirmed send, encrypted storage), the worker runtime's
// guarantees (no network or navigation from add-on code, sanitized UI), admin seeding of the example
// add-ons running in the new runtime, reports and removal (a removed add-on stops running), add-ons
// written for the old runtime, and server add-ons with member consent and pinned updates.
import http from 'node:http';
import { test, expect, createServer, makeInvite, joinServer, send, adminGet, adminPut, uid } from './fixtures.mjs';

// A test add-on (worker JavaScript) that exercises every bridge call, tries every way out of the
// sandbox against a real local server (`base`), and draws the results with codehub.ui.render.
const testAddon = (base) => `var ctx = 'waiting', out = 'idle', trap = '';
var LABELS = { read: 'Read', ins: 'Insert', send: 'Send', long: 'Send long', save: 'Save', load: 'Load', net: 'Network', trap: 'Trap' };
var esc = codehub.ui.escape;
var L = '${base}';
function draw() {
  codehub.ui.render('<p id="ctx">' + esc(ctx) + '</p><p id="out">' + esc(out) + '</p>' +
    Object.keys(LABELS).map(function (k) { return '<button type="button" data-on="click" data-id="' + k + '">' + LABELS[k] + '</button>'; }).join(' ') + trap);
}
function set(t) { out = t; draw(); }
function attempt(name, fn) {
  return new Promise(function (resolve) {
    var done = function (open) { resolve(name + '=' + (open ? 'OPEN' : 'blocked')); };
    setTimeout(function () { done(false); }, 4000);
    try { fn(done); } catch (e) { done(false); }
  });
}
function network() {
  return Promise.all([
    attempt('fetch', function (done) { fetch(L + 'fetch').then(function () { done(true); }, function () { done(false); }); }),
    attempt('xhr', function (done) { var x = new XMLHttpRequest(); x.open('GET', L + 'xhr'); x.onload = function () { done(true); }; x.onerror = function () { done(false); }; x.send(); }),
    attempt('ws', function (done) { var w = new WebSocket(L.replace('http', 'ws') + 'ws'); w.onopen = function () { done(true); }; w.onerror = function () { done(false); }; }),
    attempt('es', function (done) { var s = new EventSource(L + 'es'); s.onopen = function () { done(true); }; s.onerror = function () { s.close(); done(false); }; }),
    attempt('importScripts', function (done) { importScripts(L + 'imp.js'); done(true); }),
    attempt('import', function (done) { import(L + 'dyn.js').then(function () { done(true); }, function () { done(false); }); }),
    attempt('worker', function (done) { var w = new Worker(L + 'w.js'); w.onmessage = function () { done(true); }; w.onerror = function () { done(false); }; }),
    attempt('location', function (done) { try { self.location.href = L + 'nav'; } catch (e) {} done(String(self.location.href).indexOf('leak') >= 0); }),
  ]);
}
codehub.ready().then(function (i) {
  ctx = 'ctx:' + i.context.kind + ':' + i.context.name + ':' + i.context.me.name + ':' + i.perms.join(',') + ':' + i.theme.mode;
  draw();
});
codehub.ui.on(function (e) {
  if (e.type === 'submit') return set('submit:' + JSON.stringify(e.value));
  if (e.type !== 'click') return;
  if (e.id === 'read') codehub.getMessages(5).then(function (m) { set('msgs:' + m.map(function (x) { return x.author + '=' + x.text; }).join('|')); }, function (er) { set('err:' + er.code); });
  if (e.id === 'ins') codehub.insertText('typed by the add-on');
  if (e.id === 'send') codehub.sendMessage('sent by the add-on').then(function () { set('sent'); }, function (er) { set('err:' + er.code); });
  if (e.id === 'long') codehub.sendMessage('looks harmless' + '\\n'.repeat(30) + 'hidden tail line').then(function () { set('sent long'); }, function (er) { set('err:' + er.code); });
  if (e.id === 'save') codehub.storage.set('k', { secret: 'kept-in-storage' }).then(function () { set('saved'); }, function (er) { set('err:' + er.code); });
  if (e.id === 'load') codehub.storage.get('k').then(function (v) { set('loaded:' + (v && v.secret)); }, function (er) { set('err:' + er.code); });
  if (e.id === 'net') { set('trying'); network().then(function (r) { set('net:' + r.join(',')); }); }
  if (e.id === 'trap') {
    trap = '<a href="' + L + 'a">open link</a><meta http-equiv="refresh" content="1;url=' + L + 'm">' +
      '<iframe src="' + L + 'i"></iframe><img alt="pic" src="' + L + 'img.png" srcset="' + L + 's.png 2x">' +
      '<button type="button" onclick="location=\\'' + L + 'x\\'">Inline handler</button>' +
      '<form action="' + L + 'f" data-on="submit" data-id="f"><input name="q" value="secret" aria-label="Field"><button>Submit form</button></form>';
    set('trap set');
  }
});
draw();`;

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
  // Anything add-on code manages to send out would arrive here.
  const hits = [];
  const leakServer = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' });
    res.end('');
  });
  leakServer.on('upgrade', (req, socket) => {
    hits.push(req.url);
    socket.destroy();
  });
  await new Promise((resolve) => leakServer.listen(0, '127.0.0.1', resolve));
  test.info().annotations.push({ type: 'leak server', description: String(leakServer.address().port) });
  const TEST_ADDON = testAddon(`http://127.0.0.1:${leakServer.address().port}/leak/`);
  try {
    const alice = await users('alice');
    await createServer(alice, 'Addon Lab');
    await alice.getByRole('button', { name: /general/ }).first().click();
    await send(alice, 'hello addon world');

    // Builder with live preview (mock bridge, sample data).
    await openPalette(alice, 'Create an add-on');
    const hub = await fillBuilder(alice, {
      name: 'Echo pad',
      perms: ['See where it’s open', 'Read messages', 'Write in your message box', 'Send messages as you', 'Store its own data'],
      code: TEST_ADDON,
    });
    const preview = alice.frameLocator('.ad-preview-frame iframe');
    await expect(preview.locator('#ctx')).toHaveText(/^ctx:preview:Preview:Alice:context,readMessages,composer,send,storage:(dark|light)$/, { timeout: 20_000 });
    await preview.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(preview.locator('#out')).toContainText('msgs:');
    await expect(preview.locator('#out')).toContainText('Linus=Reminder: freeze starts Friday');
    await preview.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(hub.getByRole('log', { name: 'Preview console' })).toContainText('sendMessage → “sent by the add-on” (preview: not sent');

    // Publish -> details -> install with the permissions shown first.
    await hub.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(hub.getByRole('heading', { name: 'Echo pad' })).toBeVisible();
    await expect(hub.getByText('Permissions it asks for')).toBeVisible();
    await hub.getByRole('button', { name: 'Install', exact: true }).click();
    const install = alice.getByRole('dialog', { name: 'Install Echo pad for you' });
    await expect(install.getByRole('checkbox', { name: /^Send messages as you/ })).toBeChecked();
    await install.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(hub.getByText('Installed', { exact: true })).toBeVisible();
    const id = await addonId('Echo pad');
    const me = await uid(alice);
    const pub = await adminGet(`pub/addons/${id}`);
    expect(pub.perms).toBe('context,readMessages,composer,send,storage');
    expect(pub.rt).toBe(2);
    expect((await adminGet(`pub/addonCode/${id}`)).sha).toBe(pub.sha);
    expect(await adminGet(`udata/${me}/addons/${id}`)).toMatchObject({ sha: pub.sha, publisher: me, rt: 2 });
    expect((await adminGet(`udata/${me}/addonPin/${id}`)).c0).toContain('codehub.ready');
    await alice.keyboard.press('Escape');
    await expect(hub).toHaveCount(0);

    // Run it from the chat header's Add-ons panel.
    await alice.getByRole('button', { name: 'Add-ons', exact: true }).click();
    const panel = alice.getByRole('complementary', { name: 'Add-ons' });
    await panel.getByRole('button', { name: 'Open Echo pad' }).click();
    const frame = alice.frameLocator('iframe[title="Echo pad (add-on)"]');
    const btn = (name) => frame.getByRole('button', { name, exact: true });
    await expect(frame.locator('#ctx')).toHaveText(/^ctx:channel:general:Alice:context,readMessages,composer,send,storage:/, { timeout: 20_000 });
    await btn('Read').click();
    await expect(frame.locator('#out')).toHaveText('msgs:Alice=hello addon world');

    await btn('Insert').click();
    await expect(alice.locator('textarea[aria-label^="Message"]')).toHaveValue(/typed by the add-on/);
    await alice.locator('textarea[aria-label^="Message"]').fill('');

    // sendMessage asks first, showing the full text (here 31 lines whose last one would be out of
    // view) with its size; "Don't send" has focus and Send only works after a second.
    await btn('Send long').click();
    const ask = alice.getByRole('alertdialog', { name: 'Send a message for Echo pad?' });
    const sendBtn = ask.getByRole('button', { name: 'Send', exact: true });
    await expect(sendBtn).toBeDisabled();
    await expect(ask.getByRole('button', { name: 'Don’t send' })).toBeFocused();
    const full = ask.getByRole('region', { name: 'Full message text, 31 lines' });
    await expect(full).toContainText('hidden tail line');
    await expect(ask.locator('.ad-send-stats')).toContainText('31 lines · 60 characters · scroll to read all of it');
    await full.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(full.getByText('hidden tail line')).toBeInViewport();
    await expect(sendBtn).toBeEnabled({ timeout: 3000 });
    await ask.getByRole('button', { name: 'Don’t send' }).click();
    await expect(frame.locator('#out')).toHaveText('err:CANCELLED');
    await alice.waitForTimeout(3100); // one send every 3 s
    await btn('Send').click();
    const ask2 = alice.getByRole('alertdialog', { name: 'Send a message for Echo pad?' });
    await expect(ask2.locator('.ad-send-stats')).toHaveText('1 line · 18 characters');
    await ask2.getByRole('button', { name: 'Send', exact: true }).click(); // waits until it is enabled
    await expect(frame.locator('#out')).toHaveText('sent');
    const sent = alice.locator('.msg', { hasText: 'sent by the add-on' });
    await expect(sent.locator('.ad-via')).toHaveText('via 🧩 Echo pad');

    // Storage is sealed with the vault key and survives a reload.
    await btn('Save').click();
    await expect(frame.locator('#out')).toHaveText('saved');
    await expect.poll(async () => (await adminGet(`udata/${me}/addonStore/${id}`))?.n || 0).toBeGreaterThan(0);
    const stored = await adminGet(`udata/${me}/addonStore/${id}`);
    expect(stored.iv).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('kept-in-storage');
    await alice.reload();
    await alice.getByRole('button', { name: 'Add-ons', exact: true }).click();
    await alice.getByRole('complementary', { name: 'Add-ons' }).getByRole('button', { name: 'Open Echo pad' }).click();
    await btn('Load').click();
    await expect(frame.locator('#out')).toHaveText('loaded:kept-in-storage');

    // The old exploit: add-on code can't reach the network or navigate. Every attempt from the worker
    // fails, and nothing ever reaches the (real, local) server.
    await btn('Network').click();
    await expect(frame.locator('#out')).toHaveText(
      'net:fetch=blocked,xhr=blocked,ws=blocked,es=blocked,importScripts=blocked,import=blocked,worker=blocked,location=blocked',
      { timeout: 20_000 },
    );
    // Markup that would navigate, embed or run script is sanitized away; forms only send events.
    await btn('Trap').click();
    await expect(frame.locator('#out')).toHaveText('trap set');
    await expect(frame.getByText('open link')).toBeVisible();
    const rendered = frame.locator('.ch-root');
    await expect(rendered.locator('img[alt="pic"]')).toHaveCount(1);
    await expect(rendered.locator('a, meta, iframe, object, embed, script, [href], [action], [onclick], [srcset], [src]')).toHaveCount(0);
    await expect(frame.locator('head meta[http-equiv="refresh"], body iframe, body a')).toHaveCount(0);
    await frame.getByRole('button', { name: 'Inline handler' }).click();
    await frame.getByRole('button', { name: 'Submit form' }).click();
    await expect(frame.locator('#out')).toHaveText('submit:{"q":"secret"}');
    await frame.getByRole('textbox', { name: 'Field' }).fill('typed');
    await frame.getByRole('textbox', { name: 'Field' }).press('Enter');
    await expect(frame.locator('#out')).toHaveText('submit:{"q":"typed"}');
    await alice.waitForTimeout(1500); // the stripped meta refresh would have fired by now
    const frameEl = await alice.locator('iframe[title="Echo pad (add-on)"]').elementHandle();
    expect((await frameEl.contentFrame()).url(), 'the add-on frame is still on its own document').toBe('about:srcdoc');
    await expect(alice.getByRole('complementary', { name: 'Add-ons' }).getByRole('alert')).toHaveCount(0);
    await expect(frame.locator('#ctx')).toContainText('ctx:channel:general');
    expect(hits).toEqual([]);

    // An add-on installed for the old runtime (document model) is not run; it says it needs an update.
    const oldSha = 'ab'.repeat(32);
    await adminPut('pub/addons/legacyPad', { name: 'Old pad', icon: '📜', version: '1.0.0', sha: oldSha, size: 10, by: me, ts: Date.now() });
    await adminPut(`udata/${me}/addons/legacyPad`, { sha: oldSha, at: 1, v: '1.0.0', name: 'Old pad', icon: '📜', perms: 'readMessages' });
    await alice.getByRole('button', { name: 'Back to the add-on list' }).click();
    const panel2 = alice.getByRole('complementary', { name: 'Add-ons' });
    await expect(panel2.locator('.ad-row', { hasText: 'Old pad' })).toContainText('needs update for the new add-on runtime');
    await panel2.getByRole('button', { name: 'Open Old pad' }).click();
    await expect(panel2).toContainText('Needs update for the new add-on runtime');
    await expect(panel2).toContainText('Its publisher hasn’t published an update yet.');
    await expect(alice.locator('iframe[title="Old pad (add-on)"]')).toHaveCount(0);

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
  } finally {
    leakServer.close();
  }
  expect(hits, 'nothing add-on code tried ever reached the network').toEqual([]);
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

  // Bob installs both examples for himself.
  const bob = await users('bob');
  await createServer(bob, 'Bob Base');
  await bob.getByRole('button', { name: /general/ }).first().click();
  await send(bob, 'deploy deploy pipeline tonight');
  await openPalette(bob, 'Browse add-ons');
  const hub = bob.getByRole('dialog', { name: 'Add-ons' });
  await hub.getByLabel('Search add-ons').fill('pomodoro');
  await hub.getByRole('button', { name: /Pomodoro timer, version 2\.0\.0/ }).click();
  await expect(hub.getByText('Store its own data')).toBeVisible();
  await expect(hub.locator('.ad-chip.admin')).toHaveText('app admin');
  await hub.getByRole('button', { name: 'Install', exact: true }).click();
  await bob.getByRole('dialog', { name: /Install Pomodoro timer/ }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(hub.getByText('Installed', { exact: true })).toBeVisible();
  await hub.getByRole('button', { name: 'Back to the directory' }).click();
  await hub.getByLabel('Search add-ons').fill('');
  await hub.getByRole('button', { name: /Channel word cloud, version 2\.0\.0/ }).click();
  await hub.getByRole('button', { name: 'Install', exact: true }).click();
  await bob.getByRole('dialog', { name: /Install Channel word cloud/ }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(hub.getByText('Installed', { exact: true })).toBeVisible();

  // Report the word cloud (kind `addon`, target = its pub/addons id).
  await hub.getByRole('button', { name: 'Report' }).click();
  const report = bob.getByRole('dialog', { name: 'Report “Channel word cloud”' });
  await report.getByRole('radio', { name: 'Spam' }).check();
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(bob.getByRole('dialog', { name: 'Report sent' })).toBeVisible();
  await bob.getByRole('dialog', { name: 'Report sent' }).getByRole('button', { name: 'Done' }).click();
  await bob.keyboard.press('Escape');
  const cloudId = Object.entries((await adminGet('pub/addons')) || {}).find(([, a]) => a.name === 'Channel word cloud')[0];
  expect(Object.values(await adminGet('reports'))).toContainEqual(expect.objectContaining({ kind: 'addon', target: cloudId, reason: 'spam' }));

  // The Pomodoro example runs in the worker runtime and keeps its state in storage.
  await bob.getByRole('button', { name: 'Add-ons', exact: true }).click();
  const bobPanel = bob.getByRole('complementary', { name: 'Add-ons' });
  await bobPanel.getByRole('button', { name: 'Open Pomodoro timer' }).click();
  const timer = bob.frameLocator('iframe[title="Pomodoro timer (add-on)"]');
  await expect(timer.locator('#time')).toHaveText('25:00', { timeout: 20_000 });
  await expect(timer.locator('#meta')).toContainText('Sessions completed: 0');
  await timer.getByRole('button', { name: 'Short break' }).click();
  await expect(timer.locator('#time')).toHaveText('05:00');
  await expect(timer.getByRole('button', { name: 'Short break' })).toBeFocused(); // re-renders keep focus
  await timer.getByRole('button', { name: 'Start' }).click();
  await expect(timer.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(timer.locator('#time')).toHaveText(/^04:5\d$/, { timeout: 5000 });
  await bob.waitForTimeout(800); // storage is written after a short debounce
  await bob.getByRole('button', { name: 'Back to the add-on list' }).click();
  await bobPanel.getByRole('button', { name: 'Open Pomodoro timer' }).click();
  await expect(timer.getByRole('button', { name: 'Short break' })).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  await expect(timer.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(timer.locator('#time')).toHaveText(/^04:\d\d$/);

  // The word cloud example reads the channel in the worker runtime.
  await bob.getByRole('button', { name: 'Back to the add-on list' }).click();
  await bobPanel.getByRole('button', { name: 'Open Channel word cloud' }).click();
  const cloudFrame = bob.frameLocator('iframe[title="Channel word cloud (add-on)"]');
  await expect(cloudFrame.getByRole('list', { name: 'Most used words' })).toContainText('deploy, used 2 times', { timeout: 20_000 });
  await expect(cloudFrame.locator('#sub')).toHaveText(/^From the last \d+ messages?\.$/);

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

  // Bob's open word cloud stops at once and won't start again: removed add-ons don't run.
  await expect(bobPanel).toContainText('is no longer published', { timeout: 20_000 });
  await expect(bob.locator('iframe[title="Channel word cloud (add-on)"]')).toHaveCount(0);
  await bob.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(bobPanel.locator('.ad-row', { hasText: 'Channel word cloud' })).toContainText('removed from the directory');
  await bobPanel.getByRole('button', { name: 'Open Channel word cloud' }).click();
  await expect(bobPanel).toContainText('Removed from the directory');
  await expect(bob.locator('iframe[title="Channel word cloud (add-on)"]')).toHaveCount(0);
  await bobPanel.getByRole('button', { name: 'Uninstall Channel word cloud' }).click();
  await expect.poll(async () => adminGet(`udata/${await uid(bob)}/addons/${cloudId}`)).toBeNull();
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
  const code = (marker) => `function show(w) { codehub.ui.render('<p id="v">${marker}</p><p id="w">' + codehub.ui.escape(w) + '</p>'); }
show('…');
codehub.ready().then(function () { return codehub.getMessages(20); }).then(function (m) {
  show(m.map(function (x) { return x.text; }).join(' / '));
}, function (e) { show('err:' + e.code); });`;
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

  // The publisher unpublishes it: the server copy stops running for members right away.
  await openPalette(alice, 'Browse add-ons');
  const hub3 = alice.getByRole('dialog', { name: 'Add-ons' });
  await hub3.getByLabel('Search add-ons').fill('Team board');
  await hub3.getByRole('button', { name: /Team board, version 1\.1\.0/ }).click();
  await hub3.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await hub3.getByRole('button', { name: 'Unpublish for everyone?' }).click();
  await expect.poll(async () => adminGet(`pub/addons/${id}`)).toBeNull();
  const bobPanel = bob.getByRole('complementary', { name: 'Team board' });
  await expect(bobPanel).toContainText('Removed from the directory', { timeout: 20_000 });
  await expect(bobPanel).toContainText('A server manager can remove it');
  await expect(bob.locator('iframe[title="Team board (add-on)"]')).toHaveCount(0);
});
