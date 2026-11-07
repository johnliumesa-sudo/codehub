// Round 3, personal: status modes + custom status as other members see them (and DND muting desktop
// alerts), favorites, server folders (menu and drag and drop), private notes, appearance settings.
import { test, expect, createServer, makeInvite, joinServer, send, adminGet, adminPut, uid } from './fixtures.mjs';

const statusButton = (page) => page.getByRole('button', { name: /^Status: .*Change status$/ });

async function setMode(page, label) {
  await statusButton(page).click();
  await page.getByRole('menu', { name: 'Set status' }).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  await expect(page.getByRole('menu', { name: 'Set status' })).toHaveCount(0);
}

async function openGeneral(page) {
  await page.locator('.ly-chan-main', { hasText: 'general' }).first().click();
  await expect(page.locator('textarea[aria-label^="Message"]')).toBeEnabled({ timeout: 30_000 });
}

test('status modes and custom status reach other members; Do Not Disturb mutes desktop alerts', async ({ users }) => {
  const alice = await users('alice');
  const bob = await users('bob');
  // Count desktop notifications in Alice's tab instead of showing them.
  await alice.addInitScript(() => {
    window.__notes = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
      constructor(title, opts) { window.__notes.push({ title, body: opts?.body }); }
      close() {}
    }
    window.Notification = FakeNotification;
  });
  await createServer(alice, 'Statusville');
  await joinServer(bob, await makeInvite(alice), 'Statusville');
  await adminPut(`notifPrefs/${await uid(alice)}/settings`, { desktop: true, preview: false, mentionsOnly: false });
  await alice.reload();
  await expect(statusButton(alice)).toBeVisible({ timeout: 60_000 });

  // Custom status from the status menu (preset, edited), seen by Bob in the member list and profile card.
  await statusButton(alice).click();
  await alice.getByRole('menuitem', { name: /Set a custom status/ }).click();
  const dlg = alice.getByRole('dialog', { name: 'Set a custom status' });
  await dlg.getByRole('button', { name: /Coding/ }).click();
  await dlg.getByLabel('Status text').fill('Shipping round 3');
  await dlg.getByLabel('Clear after').selectOption('1h');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(alice.locator('.ly-user-status')).toContainText('Shipping round 3');
  const aliceRow = bob.locator('.ly-member', { hasText: 'Alice' });
  await expect(aliceRow).toContainText('Shipping round 3');
  await expect(aliceRow).toContainText('💻');

  // Do not disturb: a red dot and label for Bob, everywhere presence shows.
  await setMode(alice, 'Do not disturb');
  await expect(alice.locator('.ly-user-status')).toContainText('Shipping round 3');
  await expect(statusButton(alice)).toHaveAccessibleName(/Do not disturb/);
  await expect(aliceRow.locator('.ly-presence.dnd')).toBeVisible();
  await aliceRow.click();
  const card = bob.getByRole('dialog', { name: 'Alice' });
  await expect(card).toContainText('Do not disturb');
  await expect(card).toContainText('Shipping round 3');
  await bob.keyboard.press('Escape');

  // ...and in the @mention list.
  await openGeneral(bob);
  const box = bob.locator('textarea[aria-label^="Message"]');
  await box.fill('@Ali');
  const option = bob.getByRole('listbox', { name: 'Members' }).getByRole('option', { name: /Alice/ });
  await expect(option).toContainText('Do not disturb');
  await expect(option).toContainText('Shipping round 3');
  await box.fill('');

  // DND: a mention still reaches the bell, but no desktop notification is shown.
  await alice.getByRole('button', { name: 'Direct messages', exact: true }).click();
  await send(bob, '@Alice ping while busy');
  await expect(alice.getByTestId('notif-badge')).toBeVisible({ timeout: 20_000 });
  await alice.waitForTimeout(1500);
  expect(await alice.evaluate(() => window.__notes.length)).toBe(0);

  // Online again: the next mention shows a desktop notification.
  await setMode(alice, 'Online');
  await expect(aliceRow.locator('.ly-presence.online')).toBeVisible();
  await send(bob, '@Alice ping again');
  await expect.poll(() => alice.evaluate(() => window.__notes.length), { timeout: 20_000 }).toBeGreaterThan(0);

  // Invisible: Bob sees Alice offline; Alice sees "Invisible".
  await setMode(alice, 'Invisible');
  await expect(aliceRow.locator('.ly-presence.offline')).toBeVisible();
  await expect(aliceRow).toHaveClass(/offline/);
  await expect(alice.locator('.ly-userpanel .ly-presence.invisible')).toBeVisible();
  const pubAfter = await adminGet(`upub/${await uid(alice)}/status/now`);
  expect(JSON.stringify(pubAfter)).not.toContain('invisible');
  await setMode(alice, 'Online');
  await expect(aliceRow.locator('.ly-presence.online')).toBeVisible();

  // Clearing the custom status removes it for Bob too.
  await statusButton(alice).click();
  await alice.getByRole('menuitem', { name: 'Clear custom status' }).click();
  await expect(aliceRow).not.toContainText('Shipping round 3');
});

test('favorites (header star, row star, reorder, open) and server folders (menu, collapse, drag and drop)', async ({ users }) => {
  const alice = await users('alice');
  const rail = alice.getByRole('navigation', { name: 'Servers' });
  await createServer(alice, 'Alpha');
  await createServer(alice, 'Beta');
  await openGeneral(alice);

  // Star #general of Beta from the chat header, and #general of Alpha from its sidebar row.
  await alice.getByRole('button', { name: 'Add to Favorites', exact: true }).click();
  await expect(alice.getByRole('button', { name: 'Remove from Favorites', exact: true })).toBeVisible();
  const favs = alice.getByRole('region', { name: 'Favorites' });
  await expect(favs.getByRole('listitem')).toHaveCount(1);
  await expect(favs.getByRole('listitem').first()).toContainText('#general');
  await expect(favs.getByRole('listitem').first()).toContainText('Beta');
  await rail.getByRole('button', { name: 'Alpha', exact: true }).click();
  await expect(alice.locator('.ly-server-title')).toContainText('Alpha');
  await alice.getByRole('button', { name: 'Add #general to Favorites' }).click();
  await expect(favs.getByRole('listitem')).toHaveCount(2);
  await expect(alice.locator('.ly-chan').getByRole('button', { name: 'Remove #general from Favorites' })).toHaveAttribute('aria-pressed', 'true');

  // Reorder with the move buttons, then open a favorite.
  await favs.getByRole('listitem').first().getByRole('button', { name: /Move .* down/ }).click();
  await expect(favs.getByRole('listitem').first()).toContainText('Alpha');
  await expect(favs.getByRole('listitem').nth(1)).toContainText('Beta');
  await favs.getByRole('listitem').nth(1).getByRole('button', { name: /#general/ }).first().click();
  await expect(alice.locator('.ly-server-title')).toContainText('Beta');
  await alice.reload();
  await expect(alice.getByRole('region', { name: 'Favorites' }).getByRole('listitem').first()).toContainText('Alpha', { timeout: 30_000 });

  // Server folders from the keyboard: Shift+F10 on a server opens its folder menu.
  await rail.getByRole('button', { name: 'Alpha', exact: true }).focus();
  await alice.keyboard.press('Shift+F10');
  await alice.getByRole('menu', { name: /Folders for Alpha/ }).getByRole('menuitem', { name: /New folder with this server/ }).click();
  const fdlg = alice.getByRole('dialog', { name: 'New server folder' });
  await fdlg.getByLabel('Folder name').fill('Work');
  await fdlg.getByRole('checkbox', { name: /Beta/ }).check();
  await fdlg.getByRole('button', { name: 'Create folder' }).click();
  const folder = alice.getByRole('group', { name: 'Folder Work' });
  await expect(folder.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
  await expect(folder.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
  const head = folder.getByRole('button', { name: /^Folder Work, 2 servers/ });
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(folder.getByRole('button', { name: 'Alpha', exact: true })).toBeHidden();
  await head.click();
  await expect(folder.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
  // The folder name is sealed with Alice's key.
  const stored = await adminGet(`udata/${await uid(alice)}/serverFolders`);
  expect(Object.values(stored)).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain('Work');

  // Drag and drop a new server into the folder, then take it out through its menu.
  await createServer(alice, 'Gamma');
  await rail.getByRole('button', { name: 'Gamma', exact: true }).dragTo(head);
  await expect(folder.getByRole('button', { name: 'Gamma', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Folder Work, 3 servers/ })).toBeVisible();
  await folder.getByRole('button', { name: 'Gamma', exact: true }).click({ button: 'right' });
  await alice.getByRole('menuitem', { name: /Take out of “Work”/ }).click();
  await expect(folder.getByRole('button', { name: 'Gamma', exact: true })).toHaveCount(0);
  await expect(rail.getByRole('button', { name: 'Gamma', exact: true })).toBeVisible();

  // Deleting the folder keeps its servers in the rail.
  await rail.getByRole('button', { name: /^Folder Work/ }).click({ button: 'right' });
  await alice.getByRole('menuitem', { name: /Delete folder/ }).click();
  await expect(alice.getByRole('group', { name: 'Folder Work' })).toHaveCount(0);
  await expect(rail.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
});

test('private notes on profile cards, and appearance settings applied before paint and synced', async ({ users }) => {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Notes');
  await joinServer(bob, await makeInvite(alice), 'Notes');
  const aliceUid = await uid(alice);
  const bobUid = await uid(bob);

  // Note on Bob's card: saved encrypted on blur, marked in the member list, saved again when the card closes.
  const bobRow = alice.locator('.ly-member', { hasText: 'Bob' });
  await bobRow.click();
  const card = alice.getByRole('dialog', { name: 'Bob' });
  const note = card.getByLabel(/^Note/);
  await note.fill('Met at the hackathon');
  await note.press('Tab');
  await expect(card).toContainText('Saved');
  await expect(bobRow.getByRole('img', { name: /private note/ })).toBeVisible();
  const box = await adminGet(`udata/${aliceUid}/userNotes/${bobUid}`);
  expect(typeof box.ct).toBe('string');
  expect(JSON.stringify(box)).not.toContain('hackathon');
  await note.fill('Met at the hackathon, likes Rust');
  await alice.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await bobRow.click();
  await expect(alice.getByRole('dialog', { name: 'Bob' }).getByLabel(/^Note/)).toHaveValue('Met at the hackathon, likes Rust');
  await alice.keyboard.press('Escape');
  // My own card has no note field.
  await alice.locator('.ly-member', { hasText: 'Alice' }).click();
  await expect(alice.getByRole('dialog', { name: 'Alice' }).getByLabel(/^Note/)).toHaveCount(0);
  await alice.keyboard.press('Escape');

  // Appearance: density, font size, chat width, 24-hour clock, focus rings.
  await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const settings = alice.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('radiogroup', { name: 'Message density' }).getByRole('radio', { name: /Compact/ }).click();
  await settings.getByLabel('Font size').fill('110');
  await settings.getByLabel('Chat width').selectOption('narrow');
  await settings.getByRole('radiogroup', { name: 'Timestamps' }).getByRole('radio', { name: /24-hour/ }).click();
  await settings.getByLabel('High-contrast focus rings').check();
  const html = alice.locator('html');
  await expect(html).toHaveClass(/ap-compact/);
  await expect(html).toHaveClass(/ap-font/);
  await expect(html).toHaveClass(/ap-focus-rings/);
  await expect(html).toHaveAttribute('data-ap-width', 'narrow');
  await expect(html).toHaveAttribute('data-ap-clock', '24');
  expect(await alice.evaluate(() => document.documentElement.style.getPropertyValue('--ap-font-scale'))).toBe('1.1');

  // Sync uploads the choices to my private data; turning it off removes them.
  await settings.getByLabel('Sync across my devices').check();
  await expect.poll(() => adminGet(`udata/${aliceUid}/appearance/prefs`), { timeout: 15_000 })
    .toMatchObject({ density: 'compact', font: 110, chatWidth: 'narrow', clock: '24', focusRings: true, reduceMotion: false });
  await settings.getByLabel('Sync across my devices').uncheck();
  await expect.poll(() => adminGet(`udata/${aliceUid}/appearance/prefs`), { timeout: 15_000 }).toBeNull();

  // The device's reduced-motion request turns it on (and locks the checkbox).
  await alice.emulateMedia({ reducedMotion: 'reduce' });
  await expect(html).toHaveClass(/ap-reduce-motion/);
  await expect(settings.getByLabel('Reduce motion')).toBeDisabled();
  await expect(settings.getByLabel('Reduce motion')).toBeChecked();
  await alice.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(html).not.toHaveClass(/ap-reduce-motion/);
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // 24-hour timestamps on messages.
  await openGeneral(alice);
  await send(alice, 'clock check');
  await expect(alice.locator('.msg', { hasText: 'clock check' }).locator('.msg-time')).toHaveText(/^\d{1,2}:\d{2}$/);

  // After a reload the classes are on <html> before the app (or even <body>) exists: no flash.
  await alice.addInitScript(() => {
    window.__apBoot = null;
    const seen = () => {
      const de = document.documentElement;
      if (!window.__apBoot && de && de.classList.contains('ap-compact')) {
        window.__apBoot = { body: !!document.body, app: !!window.__codehubTestExt, width: de.getAttribute('data-ap-width') };
      }
    };
    // Init scripts run before <html> exists: watch the whole document.
    new MutationObserver(seen).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await alice.reload();
  await expect(statusButton(alice)).toBeVisible({ timeout: 60_000 });
  expect(await alice.evaluate(() => window.__apBoot)).toEqual({ body: false, app: false, width: 'narrow' });
  await expect(html).toHaveClass(/ap-compact/);
});

test('auto-idle after 10 minutes without input, back online on activity', async ({ users }) => {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Idlers');
  await joinServer(bob, await makeInvite(alice), 'Idlers');
  const aliceRow = bob.locator('.ly-member', { hasText: 'Alice' });
  await expect(aliceRow.locator('.ly-presence.online')).toBeVisible();

  // Eleven minutes pass with no input in Alice's tab (only Date moves; timers keep running).
  await alice.clock.setFixedTime(Date.now() + 11 * 60_000);
  await expect(aliceRow.locator('.ly-presence.idle')).toBeVisible({ timeout: 30_000 });
  await expect(alice.locator('.ly-userpanel .ly-presence.idle')).toBeVisible();

  // Any input brings her back.
  await alice.mouse.move(300, 300);
  await alice.mouse.move(320, 340);
  await expect(aliceRow.locator('.ly-presence.online')).toBeVisible({ timeout: 15_000 });
});
