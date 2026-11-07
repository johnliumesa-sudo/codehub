// Follow-up fixes: server emotes in text + autocomplete, forwarding, tab title, drag-and-drop upload,
// and images deleted together with their message.
import zlib from 'node:zlib';
import { test, expect, createServer, send, adminGet } from './fixtures.mjs';

/** A real w x h RGBA PNG (solid colour) so the app's image pipeline can decode it. */
function png(w, h, rgba = [255, 120, 0, 255]) {
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
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function openGeneral(page) {
  await page.getByRole('button', { name: /general/ }).first().click();
  await expect(page.locator('textarea[aria-label^="Message"]')).toBeEnabled({ timeout: 30_000 });
}

test('server emote renders in messages and autocomplete; forward; tab title', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Hub');

  // Add :wave: in Server settings -> Emotes.
  await alice.locator('.ly-server-title').click();
  await alice.getByRole('menuitem', { name: /Server settings/ }).click();
  await alice.getByRole('tab', { name: /Emotes/ }).click();
  await expect(alice.getByText(/max 48 KB/)).toBeVisible();
  await alice.locator('.md-emote-form input[type=file]').setInputFiles({ name: 'wave.png', mimeType: 'image/png', buffer: png(32, 32) });
  await expect(alice.getByLabel('Emote name')).toHaveValue('wave');
  await alice.getByRole('button', { name: 'Add emote' }).click();
  await expect(alice.locator('.md-emote-row', { hasText: ':wave:' })).toBeVisible({ timeout: 30_000 });
  await alice.keyboard.press('Escape');

  await openGeneral(alice);
  await expect(alice).toHaveTitle(/#general · Hub — Codehub/);

  // Autocomplete offers the server emote, and the message renders it as an image.
  const box = alice.locator('textarea[aria-label^="Message"]');
  await box.fill('hi :wav');
  await expect(alice.locator('.composer-suggest img.md-emote')).toBeVisible();
  await box.fill('');
  await send(alice, 'hi :wave:');
  const msg = alice.locator('.msg', { hasText: 'hi' }).last();
  await expect(msg.locator('.msg-text img.md-emote[alt=":wave:"]')).toBeVisible({ timeout: 30_000 });
  expect(await msg.locator('.msg-text img.md-emote').getAttribute('src')).toMatch(/^data:image\/(png|webp);base64,/);

  // Forward the message (into the same channel is fine for the test).
  await msg.hover();
  await msg.getByTitle('Forward').click();
  const dialog = alice.getByRole('dialog', { name: 'Forward message' });
  await dialog.locator('.cx-list-row', { hasText: 'general' }).getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(alice.locator('.cx-fwd-tag', { hasText: 'Forwarded from Alice' })).toBeVisible({ timeout: 30_000 });
});

test('drag-and-drop attaches an image; deleting the message deletes the image', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Pics');
  await openGeneral(alice);

  const b64 = png(64, 48, [0, 140, 255, 255]).toString('base64');
  const dt = await alice.evaluateHandle((data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const t = new DataTransfer();
    t.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
    return t;
  }, b64);
  await alice.dispatchEvent('.chat-main', 'dragenter', { dataTransfer: dt });
  await expect(alice.locator('.md-drop-overlay')).toBeVisible();
  await alice.dispatchEvent('.chat-main', 'drop', { dataTransfer: dt });
  await expect(alice.locator('.md-tray-item')).toHaveCount(1);

  // Image-only message: the send button is enabled without text.
  await alice.getByTitle('Send (Enter)').click();
  const msg = alice.locator('.msg').last();
  await expect(msg.locator('img').first()).toBeVisible({ timeout: 30_000 });
  const before = await adminGet('att');
  const scopes = Object.keys(before || {});
  expect(scopes.length).toBe(1);
  expect(Object.keys(before[scopes[0]]).length).toBe(1);

  await msg.hover();
  await msg.getByTitle(/^Delete/).click();
  await alice.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(alice.locator('.msg-deleted')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await adminGet(`att/${scopes[0]}`)) || null, { timeout: 15_000 }).toBeNull();
});
