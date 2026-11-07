// Bots (round 3): built-in slash commands, the bot builder and public directory, installing a bot
// in a server, bot commands, keyword triggers, welcome messages, updates, reports and removal.
import zlib from 'node:zlib';
import { test, expect, createServer, makeInvite, joinServer, send, adminGet, adminPut, uid } from './fixtures.mjs';

/** A real w x h RGBA PNG (solid colour) for the image pipeline. */
function png(w, h, rgba = [40, 160, 255, 255]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgba).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const composer = (page) => page.locator('textarea[aria-label^="Message"]');

async function openGeneral(page) {
  await page.getByRole('button', { name: /general/ }).first().click();
  await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
}

async function openBotsSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.locator('.settings-nav-item', { hasText: 'Bots' }).click();
  await expect(page.getByRole('heading', { name: 'Bots' })).toBeVisible();
}

async function closeSettings(page) {
  await page.getByRole('button', { name: 'Close settings' }).click();
}

async function openServerBots(page) {
  await page.locator('.ly-server-title').click();
  await page.getByRole('menuitem', { name: /Server settings/ }).click();
  await page.getByRole('tab', { name: /Bots/ }).click();
}

/** A 1x1 GIF for the mocked GIPHY media. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

test('built-in slash commands: shrug, me, roll, flip, spoiler, poll and gif', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Cmds');
  await openGeneral(alice);

  await send(alice, '/shrug oh well');
  const shrug = alice.locator('.msg', { hasText: 'oh well' });
  await expect(shrug.locator('.msg-text')).toHaveText('oh well ¯\\_(ツ)_/¯');
  await expect(shrug.locator('.bt-cmd-note')).toHaveText('used /shrug');

  await send(alice, '/me waves hello');
  await expect(alice.locator('.msg-text em', { hasText: 'waves hello' })).toBeVisible();

  await send(alice, '/roll 2d6');
  await expect(alice.locator('.msg-text', { hasText: 'rolled 2d6' })).toHaveText(/^🎲 rolled 2d6: [1-6] \+ [1-6] = ([2-9]|1[0-2])\s*$/);

  await send(alice, '/flip');
  await expect(alice.locator('.msg-text', { hasText: 'flipped a coin' })).toHaveText(/^🪙 flipped a coin: (Heads|Tails)\s*$/);

  await send(alice, '/spoiler the butler did it');
  const spoiler = alice.locator('.msg-text .spoiler', { hasText: 'the butler did it' });
  await expect(spoiler).toBeVisible();
  await expect(spoiler).not.toHaveClass(/revealed/);

  await send(alice, '/tableflip');
  await expect(alice.locator('.msg-text', { hasText: '┻━┻' })).toBeVisible();

  // A bad argument is refused with its usage; the composer keeps the text.
  await send(alice, '/roll 0d6');
  await expect(alice.locator('.chat-toast')).toContainText('Usage: /roll');
  await expect(composer(alice)).toHaveValue('/roll 0d6');
  await composer(alice).fill('');

  // /poll opens the existing poll creator.
  await send(alice, '/poll');
  const pollDlg = alice.getByRole('dialog', { name: 'Create poll' });
  await expect(pollDlg).toBeVisible();
  await pollDlg.getByLabel('Question').fill('Lunch?');
  await pollDlg.getByLabel('Option 1').fill('Pizza');
  await pollDlg.getByLabel('Option 2').fill('Tacos');
  await pollDlg.getByRole('button', { name: 'Post poll' }).click();
  const poll = alice.locator('.msg', { has: alice.getByRole('group', { name: 'Poll: Lunch?' }) });
  await expect(poll).toBeVisible();
  await expect(poll.locator('.bt-cmd-note')).toHaveText('used /poll');

  // /gif without a GIPHY key explains why; with one it opens the picker prefilled.
  await send(alice, '/gif cats');
  await expect(alice.locator('.chat-toast')).toContainText('GIFs are not set up');
  await composer(alice).fill('');
  await adminPut('appConfig/giphyKey', 'testkey1234567');
  let searched = '';
  await alice.route('https://api.giphy.com/**', (route) => {
    searched = new URL(route.request().url()).searchParams.get('q') || '';
    const img = { url: 'https://media.giphy.com/media/test1/200.gif', width: '200', height: '150' };
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ data: [{ id: 'test1', title: 'cat', images: { fixed_height: img, fixed_width_small: img } }] }),
    });
  });
  await alice.route('https://media.giphy.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
  await send(alice, '/gif cats');
  const picker = alice.getByRole('dialog', { name: 'GIF picker' });
  await expect(picker).toBeVisible();
  await expect(picker.getByLabel('Search GIFs')).toHaveValue('cats');
  await expect.poll(() => searched).toBe('cats');
  await picker.locator('.md-gif-item').first().click();
  await expect(picker).toHaveCount(0);
  const gifMsg = alice.locator('.msg', { has: alice.locator('.md-gifmsg') });
  await expect(gifMsg.locator('.bt-cmd-note')).toHaveText('used /gif');

  // /help lists the built-ins.
  await send(alice, '/help');
  const help = alice.getByRole('region', { name: 'Slash commands' });
  for (const c of ['/shrug', '/tableflip', '/unflip', '/me', '/roll', '/flip', '/spoiler', '/poll', '/gif']) await expect(help).toContainText(c);
});

test('bot builder, directory, install, commands, keyword triggers, update and uninstall', async ({ users }) => {
  const alice = await users('alice');

  // Build and publish a bot.
  await openBotsSettings(alice);
  await alice.getByRole('tab', { name: 'My bots' }).click();
  await alice.getByRole('button', { name: 'Create a bot' }).click();
  await alice.getByLabel('Name', { exact: true }).fill('Helper');
  await alice.getByLabel('Icon (emoji)').fill('🛠');
  // A small image replaces the emoji (shared image pipeline: re-encoded, <= 128 px).
  await alice.locator('.bt-file input[type=file]').setInputFiles({ name: 'bot.png', mimeType: 'image/png', buffer: png(300, 200) });
  await expect(alice.locator('.bt-identity img.bt-avatar')).toBeVisible();
  await alice.getByLabel('Description', { exact: true }).fill('Greets people and plays ping-pong');
  await alice.getByRole('button', { name: 'Add command' }).click();
  await alice.getByLabel('Command 1 name').fill('hello');
  await alice.getByLabel('Command 1 arguments hint').fill('<text>');
  await alice.getByLabel('Command 1 description').fill('Say hello');
  await alice.getByLabel('Command 1 response').fill('Hello {mention}! You said: {args}');
  await alice.getByRole('button', { name: 'Add trigger' }).click();
  await alice.getByLabel('Trigger 1 word or phrase').fill('ping');
  await alice.getByLabel('Trigger 1 response').fill('pong {user}');
  // Live preview through the markdown renderer.
  await expect(alice.locator('.bt-preview-text')).toContainText('Hello @Alice! You said:');
  await alice.getByRole('button', { name: 'Publish bot' }).click();
  await expect(alice.locator('.bt-notice')).toContainText('published');
  await expect(alice.getByRole('list', { name: 'My bots' })).toContainText('Helper');
  const helper = Object.values(await adminGet('pub/bots')).find((b) => b.name === 'Helper');
  expect(helper).toMatchObject({ name: 'Helper', ver: 1, glyph: '🛠' });
  expect(helper.imgType).toMatch(/^image\/(webp|jpeg|png)$/);
  expect(helper.img.length).toBeLessThanOrEqual(20000);
  expect(JSON.parse(helper.def).commands[0]).toMatchObject({ name: 'hello', usage: '<text>' });

  // The directory lists it with its details.
  await alice.getByRole('tab', { name: 'Directory' }).click();
  await alice.getByLabel('Search bots').fill('ping-pong');
  await alice.getByRole('button', { name: 'Helper: details' }).click();
  await expect(alice.getByRole('article', { name: 'Helper details' })).toContainText('/hello <text>');
  await closeSettings(alice);

  // Install it in a server.
  await createServer(alice, 'Botland');
  await openServerBots(alice);
  await alice.getByRole('button', { name: 'Add a bot' }).click();
  await alice.getByRole('button', { name: 'Helper: details' }).click();
  await alice.getByRole('button', { name: 'Add to server' }).click();
  await expect(alice.locator('.bt-notice')).toContainText('Helper was added');
  await expect(alice.getByRole('list', { name: 'Installed bots' })).toContainText('Helper');
  await alice.keyboard.press('Escape');
  await openGeneral(alice);

  // The bot's command is in the slash menu; running it posts the reply with the bot line.
  const box = composer(alice);
  await box.fill('/hel');
  await expect(alice.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /\/hello/ })).toBeVisible();
  await box.fill('');
  await send(alice, '/hello **world** @everyone now');
  const reply = alice.locator('.msg', { hasText: 'You said:' });
  await expect(reply.locator('.msg-text')).toHaveText('Hello @Alice! You said: **world** @everyone now');
  await expect(reply.locator('.msg-text strong')).toHaveCount(0); // member input stays literal
  await expect(reply.locator('.msg-text .mention')).toHaveCount(1); // only {mention}, not the typed @everyone
  const badge = reply.locator('.bt-badge');
  await expect(badge).toContainText('Helper');
  await expect(badge).toContainText('BOT');
  await expect(badge).toContainText('via @Alice');
  await expect(badge.locator('img.bt-avatar')).toBeVisible(); // the installed copy's image
  await expect(reply.locator('.msg-author')).toBeHidden();
  await expect(reply.locator('.bt-cmd-note')).toHaveText('used /hello');

  // Keyword trigger: the reply follows the triggering message, once per cooldown.
  await send(alice, 'anyone up for ping?');
  const pong = alice.locator('.msg', { hasText: 'pong Alice' });
  await expect(pong).toHaveCount(1);
  await expect(pong.locator('.bt-cmd-note')).toHaveText('replied to a keyword');
  const texts = await alice.locator('.msg-text').allInnerTexts();
  expect(texts.indexOf('pong Alice')).toBe(texts.indexOf('anyone up for ping?') + 1);
  await send(alice, 'ping again');
  await expect(alice.locator('.msg-text', { hasText: 'ping again' })).toBeVisible();
  await alice.waitForTimeout(2500);
  await expect(pong).toHaveCount(1);

  // Message bodies (including the bot tag) stay end-to-end encrypted.
  expect(JSON.stringify(await adminGet('messages'))).not.toContain('pong');

  // A new version shows "Update available"; updating changes the reply.
  await openBotsSettings(alice);
  await alice.getByRole('tab', { name: 'My bots' }).click();
  await alice.getByRole('button', { name: 'Edit Helper' }).click();
  await alice.getByLabel('Command 1 response').fill('Hi {mention}, version two');
  await alice.getByRole('button', { name: 'Save new version' }).click();
  await expect(alice.locator('.bt-notice')).toContainText('Saved a new version');
  await closeSettings(alice);
  await openServerBots(alice);
  await expect(alice.getByText('Update available (v2)')).toBeVisible();
  await alice.getByRole('button', { name: 'Update Helper to version 2' }).click();
  await expect(alice.locator('.bt-notice')).toContainText('updated to version 2');
  await alice.keyboard.press('Escape');
  await send(alice, '/hello');
  await expect(alice.locator('.msg-text', { hasText: 'version two' })).toHaveText('Hi @Alice, version two');

  // Uninstall: the command leaves the slash menu.
  await openServerBots(alice);
  await alice.getByRole('button', { name: 'Uninstall' }).click();
  await alice.getByRole('button', { name: 'Uninstall?' }).click();
  await expect(alice.getByText('No bots are installed in this server.')).toBeVisible();
  await alice.keyboard.press('Escape');
  await box.fill('/hel');
  const menu = alice.getByRole('listbox', { name: 'Commands' });
  await expect(menu.getByRole('option', { name: /\/help/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /\/hello/ })).toHaveCount(0);
});

test('welcome message for a new member, reporting a bot and app-admin removal', async ({ users }) => {
  const alice = await users('alice');
  const aliceUid = await uid(alice);
  await createServer(alice, 'Welcomeland');
  const sid = Object.keys(await adminGet(`userServers/${aliceUid}`))[0];

  // Seed a published bot (as the builder writes it) and install it through the UI.
  const def = {
    v: 1, name: 'Greeter', glyph: '👋', desc: 'Welcomes new members',
    commands: [], triggers: [], welcome: 'Welcome {mention} to {server}! Read #rules first.',
  };
  await adminPut('pub/bots/-Ngreeter0000000001', { def: JSON.stringify(def), name: 'Greeter', desc: def.desc, glyph: '👋', ver: 1, created: Date.now(), by: aliceUid, ts: Date.now() });
  await openServerBots(alice);
  await alice.getByRole('button', { name: 'Add a bot' }).click();
  await alice.getByRole('button', { name: 'Greeter: details' }).click();
  await alice.getByRole('button', { name: 'Add to server' }).click();
  await expect(alice.getByRole('list', { name: 'Installed bots' })).toContainText('Greeter');
  await alice.keyboard.press('Escape');
  await expect.poll(async () => (await adminGet(`sconf/${sid}/bots/-Ngreeter0000000001`))?.ver).toBe(1);
  const link = await makeInvite(alice);

  // Bob joins: his own browser posts the welcome once.
  const bob = await users('bob');
  const bobUid = await uid(bob);
  await joinServer(bob, link, 'Welcomeland');
  const welcome = bob.locator('.msg', { hasText: 'Welcome @Bob to Welcomeland!' });
  await expect(welcome).toHaveCount(1, { timeout: 30_000 });
  await expect(welcome.locator('.bt-badge')).toContainText('via @Bob');
  await expect(welcome.locator('.bt-cmd-note')).toHaveText('welcome message');
  await expect(alice.locator('.msg', { hasText: 'Welcome @Bob to Welcomeland!' })).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(async () => Object.keys((await adminGet(`udata/${bobUid}/botWelcome`)) || {})).toEqual([`${sid}~-Ngreeter0000000001`]);
  await bob.reload();
  await expect(composer(bob)).toBeEnabled({ timeout: 30_000 });
  await bob.waitForTimeout(2500);
  await expect(bob.locator('.msg', { hasText: 'Welcome @Bob' })).toHaveCount(1);

  // Bob reports the bot from the directory (reports flow: plaintext, admins only).
  await openBotsSettings(bob);
  await bob.getByRole('button', { name: 'Greeter: details' }).click();
  await bob.getByRole('button', { name: 'Report' }).click();
  const dlg = bob.getByRole('dialog', { name: 'Report bot' });
  await dlg.getByLabel('Spam').check();
  await dlg.getByLabel('Note (optional)').fill('too many welcomes');
  await dlg.getByRole('button', { name: 'Send report' }).click();
  await expect(bob.getByRole('heading', { name: 'Report sent' })).toBeVisible();
  await bob.getByRole('button', { name: 'Done' }).click();
  const reports = Object.values(await adminGet('reports'));
  expect(reports).toContainEqual(expect.objectContaining({ kind: 'user', target: aliceUid, by: bobUid, reason: 'spam' }));
  expect(reports.find((r) => r.by === bobUid).note).toContain('pub/bots/-Ngreeter0000000001');
  // Bob is neither the publisher nor an app admin: no edit/unpublish/remove.
  await expect(bob.getByRole('button', { name: /Unpublish|Remove/ })).toHaveCount(0);
  await closeSettings(bob);

  // An app admin removes it from the directory; the server's pinned copy keeps working.
  const carol = await users('carol');
  await adminPut(`admins/${await uid(carol)}`, { at: Date.now() });
  await openBotsSettings(carol);
  await carol.getByRole('button', { name: 'Greeter: details' }).click();
  await carol.getByRole('button', { name: 'Remove (app admin)' }).click();
  await carol.getByRole('button', { name: 'Remove from directory?' }).click();
  await expect(carol.getByRole('button', { name: 'Greeter: details' })).toHaveCount(0);
  expect(await adminGet('pub/bots/-Ngreeter0000000001')).toBeNull();
  await openServerBots(alice);
  await expect(alice.getByRole('list', { name: 'Installed bots' })).toContainText('No longer in the directory');
});
