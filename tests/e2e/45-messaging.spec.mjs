// Round 3 messaging in the real UI: message links + jump, drafts, chat export, reminders (including
// one that comes due while the app is closed), voice messages between two browsers (fake microphone)
// and running code snippets in the sandbox (output, the 5 s guard, an HTML + CSS page).
import { readFileSync } from 'node:fs';
import { test, expect, createServer, makeInvite, joinServer, send, adminGet } from './fixtures.mjs';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
});

const composer = (page) => page.locator('textarea[aria-label^="Message"]');

async function openChannel(page, name) {
  await page.getByRole('button', { name: new RegExp(`^${name}$`) }).first().click();
  await expect(composer(page)).toHaveAttribute('aria-label', `Message #${name}`);
}

async function createTextChannel(page, name) {
  await page.getByRole('button', { name: 'Create text channel' }).click();
  await page.getByPlaceholder('new-channel').fill(name);
  await page.getByPlaceholder('new-channel').press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^${name}$`) }).first()).toBeVisible();
}

async function messageAction(page, text, action) {
  const msg = page.locator('.msg', { hasText: text }).last();
  await msg.hover();
  await msg.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test('message links jump to the message; drafts persist per conversation; export downloads decrypted history', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Links');
  await openChannel(alice, 'general');
  await send(alice, 'the target message');
  for (let i = 1; i <= 3; i++) await send(alice, `filler ${i}`);
  await expect(alice.locator('.msg-text', { hasText: 'filler 3' })).toBeVisible();

  // Copy link -> an in-app deep link on the clipboard.
  await messageAction(alice, 'the target message', 'Copy link');
  await expect(alice.locator('.chat-toast')).toContainText('Message link copied');
  const link = await alice.evaluate(() => navigator.clipboard.readText());
  const m = /#\/m\/ch\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(link);
  expect(m, link).toBeTruthy();
  const [, sid, cid, mid] = m;
  expect(link.startsWith(await alice.evaluate(() => location.origin + location.pathname))).toBe(true);

  // Pasted into another channel it renders as a chip; clicking it opens #general and highlights the message.
  await createTextChannel(alice, 'random');
  await openChannel(alice, 'random');
  await send(alice, `see ${link}`);
  const chip = alice.getByRole('button', { name: 'Jump to message in #general' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(composer(alice)).toHaveAttribute('aria-label', 'Message #general');
  await expect(alice.locator(`.msg.highlighted[data-mid="${mid}"]`)).toBeVisible();

  // The inline link in the text navigates in the app too (no new tab).
  await openChannel(alice, 'random');
  const pagesBefore = alice.context().pages().length;
  await alice.locator('.msg-text a', { hasText: '#/m/ch/' }).first().click();
  await expect(composer(alice)).toHaveAttribute('aria-label', 'Message #general');
  await expect(alice.locator(`.msg.highlighted[data-mid="${mid}"]`)).toBeVisible();
  expect(alice.context().pages().length).toBe(pagesBefore);

  // Hash routes: a missing message and a server I'm not in.
  await alice.evaluate(([s, c]) => { location.hash = `#/m/ch/${s}/${c}/-Nmissing000000000`; }, [sid, cid]);
  await expect(alice.locator('.chat-toast')).toContainText('no longer available');
  await alice.evaluate(() => { location.hash = '#/m/ch/-Nnosuchserver/-Nnochannel/-Nmid'; });
  await expect(alice.locator('.ly-toast', { hasText: 'you’re not in that server' })).toBeVisible();
  expect(await alice.evaluate(() => location.hash)).toBe('');

  // A fresh load with the link in the address bar opens it after sign-in.
  await alice.goto('about:blank');
  await alice.goto(link);
  await expect(alice.locator(`.msg[data-mid="${mid}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(composer(alice)).toHaveAttribute('aria-label', 'Message #general');

  // Drafts: unsent text survives switching conversations and a reload, with a pencil marker.
  await openChannel(alice, 'random');
  await composer(alice).fill('an unsent draft');
  await openChannel(alice, 'general');
  const drafts = alice.getByRole('region', { name: 'Drafts' });
  await expect(drafts.getByRole('button', { name: 'Draft in #random' })).toBeVisible();
  expect(await alice.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('codehub.drafts:')).map((k) => localStorage[k]).join(''))).not.toContain('an unsent draft');
  await alice.reload();
  await expect(alice.getByRole('button', { name: 'Draft in #random' })).toBeVisible({ timeout: 30_000 });
  await alice.getByRole('button', { name: 'Draft in #random' }).click();
  await expect(composer(alice)).toHaveValue('an unsent draft');
  await composer(alice).press('Enter');
  await expect(alice.locator('.msg-text', { hasText: 'an unsent draft' })).toBeVisible();
  await openChannel(alice, 'general');
  await expect(alice.getByRole('region', { name: 'Drafts' })).toHaveCount(0);
  await openChannel(alice, 'random');
  await expect(composer(alice)).toHaveValue('');

  // Export: warning first, then a decrypted JSON and Markdown download.
  await openChannel(alice, 'general');
  await alice.getByRole('button', { name: 'Export chat', exact: true }).click();
  const panel = alice.getByRole('complementary', { name: 'Export chat' });
  await expect(panel).toContainText('The exported file is not encrypted.');
  await panel.getByLabel('JSON (.json)').check();
  let wait = alice.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export unencrypted file' }).click();
  let dl = await wait;
  expect(dl.suggestedFilename()).toMatch(/^codehub-general-\d{4}-\d{2}-\d{2}\.json$/);
  const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  expect(json.format).toBe('codehub-chat-export');
  expect(json.messages.map((x) => x.text)).toEqual(expect.arrayContaining(['the target message', 'filler 3']));
  expect(json.messages.find((x) => x.text === 'the target message').id).toBe(mid);
  await expect(panel).toContainText(/Exported \d+ messages/);

  await panel.getByLabel('Markdown (.md)').check();
  await panel.getByLabel('Date range').check();
  wait = alice.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export unencrypted file' }).click();
  dl = await wait;
  const md = readFileSync(await dl.path(), 'utf8');
  expect(md).toContain('# Chat export: \\#general');
  expect(md).toContain('the target message');
  expect(md).toContain('not encrypted');
});

test('reminders: /remind and "Remind me" fire into the bell, a card and the panel; missed ones fire on next load', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Remind');
  await openChannel(alice, 'general');
  await send(alice, 'remember this message');
  await expect(alice.locator('.msg-text', { hasText: 'remember this message' })).toBeVisible();

  // /remind is local-only and never posts.
  await send(alice, '/remind 3s stretch');
  await expect(alice.getByRole('region', { name: 'Reminder set' })).toContainText('stretch');
  await expect(alice.locator('.msg-text', { hasText: '/remind' })).toHaveCount(0);
  await send(alice, '/remind whenever');
  await expect(alice.locator('.chat-toast')).toContainText('Usage: /remind');
  await expect(composer(alice)).toHaveValue('/remind whenever');
  await composer(alice).fill('');

  // It fires once: a card, the bell, and "Due" in the panel.
  const card = alice.getByRole('group', { name: 'Reminder' });
  await expect(card).toContainText('stretch', { timeout: 15_000 });
  await expect(alice.getByTestId('notif-badge')).toHaveText('1');
  await alice.locator('.nf-bell').click();
  await expect(alice.getByTestId('notif-panel')).toContainText('asked to be reminded about this');
  await alice.keyboard.press('Escape');

  // Snooze from the card: it leaves the card and moves to "Upcoming".
  await card.getByRole('button', { name: 'Snooze' }).click();
  await alice.getByRole('menuitem', { name: '10 minutes' }).click();
  await expect(card).toHaveCount(0);
  await alice.getByRole('button', { name: 'Reminders', exact: true }).click();
  const panel = alice.getByRole('complementary', { name: 'Reminders' });
  await expect(panel.getByRole('region', { name: 'Upcoming reminders' })).toContainText('stretch');

  // "Remind me…" on a message, with a note.
  await messageAction(alice, 'remember this message', 'Remind me…');
  const dialog = alice.getByRole('dialog', { name: 'Remind me' });
  await expect(dialog).toContainText('remember this message');
  await dialog.getByLabel(/Note/).fill('reply to this');
  await dialog.getByRole('button', { name: /In 3 hours/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(alice.locator('.chat-toast')).toContainText('Reminder set for');
  const upcoming = panel.getByRole('region', { name: 'Upcoming reminders' });
  await expect(upcoming).toContainText('reply to this');
  await expect(upcoming).toContainText('remember this message');

  // Done, then delete.
  const item = upcoming.getByRole('listitem').filter({ hasText: 'stretch' });
  await item.getByRole('button', { name: 'Done' }).click();
  const done = panel.getByRole('region', { name: 'Finished reminders' });
  await expect(done).toContainText('stretch');
  await done.getByRole('button', { name: /Delete reminder: stretch/ }).click();
  await expect(panel).not.toContainText('stretch');

  // Stored sealed: nothing readable in the database.
  const me = await alice.evaluate(async () => {
    const all = await new Promise((res) => { const q = indexedDB.open('firebaseLocalStorageDb'); q.onsuccess = () => { const tx = q.result.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll(); tx.onsuccess = () => res(tx.result); }; });
    return all[0]?.value?.uid;
  });
  const stored = JSON.stringify(await adminGet(`udata/${me}/reminders`));
  expect(stored).not.toContain('reply to this');
  expect(stored).toContain('"ct"');

  // Due while no tab is open: it fires on the next load, and "Open message" jumps there.
  await send(alice, '/remind 2s check the build');
  await expect(alice.getByRole('region', { name: 'Reminder set' })).toBeVisible();
  await alice.goto('about:blank');
  await alice.waitForTimeout(3500);
  await alice.goto('/');
  const late = alice.getByRole('group', { name: 'Reminder' });
  await expect(late).toContainText('check the build', { timeout: 30_000 });
  await late.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(composer(alice)).toHaveAttribute('aria-label', 'Message #general');
});

test('voice messages: record, review and send; another member plays them', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Voice');
  const invite = await makeInvite(alice);
  const bob = await users('bob');
  await joinServer(bob, invite, 'Voice');
  await openChannel(alice, 'general');
  await openChannel(bob, 'general');

  await alice.getByRole('button', { name: 'Record a voice message' }).click();
  const rec = alice.getByRole('region', { name: 'Voice message' });
  await expect(rec.getByRole('timer')).toBeVisible({ timeout: 15_000 });
  await alice.waitForTimeout(2200);
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.getByRole('group', { name: 'Recorded voice message' })).toBeVisible({ timeout: 15_000 });
  await rec.getByRole('button', { name: 'Send' }).click();
  await expect(rec).toHaveCount(0, { timeout: 30_000 });

  const mine = alice.locator('.msg .md-voice');
  await expect(mine).toHaveCount(1);
  await expect(mine.locator('.md-voice-time')).toHaveText(/^0:0[1-3]$/);

  // Bob downloads, decrypts and plays it; speed cycles.
  const theirs = bob.locator('.msg .md-voice');
  await expect(theirs).toHaveCount(1, { timeout: 30_000 });
  await theirs.getByRole('button', { name: 'Play voice message' }).click();
  await expect(theirs.getByRole('button', { name: 'Pause voice message' })).toBeVisible({ timeout: 15_000 });
  await theirs.getByRole('button', { name: /Playback speed 1×/ }).click();
  await expect(theirs.getByRole('button', { name: /Playback speed 1.5×/ })).toBeVisible();
  expect(await theirs.locator('audio').evaluate((a) => a.src.startsWith('blob:'))).toBe(true);

  // Stored like an image attachment: encrypted meta + chunks, never the raw mime type.
  const link = await alice.evaluate(() => location.origin);
  expect(link).toBeTruthy();
  const tree = await adminGet('att');
  const all = JSON.stringify(tree);
  expect(all).not.toContain('audio/');
  const scope = Object.keys(tree).find((k) => k.startsWith('ch_'));
  const att = Object.values(tree[scope])[0];
  expect(att.meta.size).toBeLessThanOrEqual(512 * 1024);
  expect(Object.keys(att.c).length).toBe(att.meta.n);

  // Deleting the message removes the clip too.
  await alice.locator('.msg', { has: alice.locator('.md-voice') }).hover();
  await alice.locator('.msg', { has: alice.locator('.md-voice') }).getByRole('button', { name: /Delete/ }).click({ modifiers: ['Shift'] });
  await expect(alice.locator('.msg .md-voice')).toHaveCount(0);
  await expect.poll(async () => JSON.stringify((await adminGet(`att/${scope}`)) || {})).toBe('{}');
});

test('run code: JavaScript output, the 5 s guard and an HTML + CSS page, only on click', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Run');
  await openChannel(alice, 'general');

  await send(alice, "```js\nconsole.log('sum', 1 + 1);\nconsole.warn({ a: [1, 2] });\nthrow new Error('boom');\n```");
  const msg = alice.locator('.msg', { hasText: "console.log('sum'" });
  await expect(msg.getByRole('button', { name: 'Run JavaScript' })).toBeVisible();
  await expect(alice.locator('iframe')).toHaveCount(0); // never auto-runs
  await msg.getByRole('button', { name: 'Run JavaScript' }).click();
  const out = msg.getByRole('region', { name: 'JavaScript output' });
  await expect(out.getByRole('log')).toContainText('sum 2');
  await expect(out.getByRole('log')).toContainText('"a"');
  await expect(out.getByRole('log')).toContainText(/Uncaught Error: boom \(line 3\)/);
  await expect(out.getByRole('status')).toHaveText('Finished');
  await out.getByRole('button', { name: 'Clear' }).click();
  await expect(out.getByRole('log')).not.toContainText('sum 2');
  await out.getByRole('button', { name: 'Run again' }).click({ timeout: 10_000 });
  await expect(out.getByRole('log')).toContainText('sum 2');

  // A busy loop is stopped after 5 s and the app stays responsive.
  await send(alice, '```javascript\nconsole.log("start"); while (true) {}\n```');
  const loop = alice.locator('.msg', { hasText: 'while (true)' });
  await loop.getByRole('button', { name: 'Run JavaScript' }).click();
  const loopOut = loop.getByRole('region', { name: 'JavaScript output' });
  await expect(loopOut.getByRole('log')).toContainText('start');
  await composer(alice).fill('still typing');
  await expect(composer(alice)).toHaveValue('still typing');
  await expect(loopOut.getByRole('status')).toContainText('Stopped: still running after 5 s', { timeout: 15_000 });
  await composer(alice).fill('');

  // HTML + CSS (+ JS) render together in the sandbox; Stop tears it down.
  await send(alice, '```html\n<p id="hello">Hello sandbox</p>\n```\n```css\n#hello { color: rgb(255, 0, 0); }\n```\n```js\nconsole.log(document.getElementById("hello").textContent)\n```');
  const page = alice.locator('.msg', { hasText: 'Hello sandbox' });
  await page.getByRole('button', { name: 'Run HTML + CSS + JS' }).click();
  const pageOut = page.getByRole('region', { name: 'HTML + CSS + JS output' });
  await expect(pageOut.getByRole('log')).toContainText('Hello sandbox');
  const frame = alice.frameLocator('.mx-run-frame:not(.hidden)');
  await expect(frame.locator('#hello')).toHaveCSS('color', 'rgb(255, 0, 0)');
  expect(await pageOut.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  await pageOut.getByRole('button', { name: 'Stop' }).click();
  await expect(pageOut.locator('iframe')).toHaveCount(0);
  await expect(pageOut.getByRole('status')).toHaveText('Stopped');
});
