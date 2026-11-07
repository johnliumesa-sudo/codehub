// Round 3 community workstream in the real UI: server templates (+ save as template), the welcome
// screen and database-enforced rules gate, events with RSVP / sidebar / panel / reminders,
// AutoMod (block and hide), and server discovery (list, discover, join through the invite flow, unlist).
import { test, expect, createServer, makeInvite, joinServer, send, adminGet, adminPut, uid } from './fixtures.mjs';

// "Join voice" really joins the event's voice channel (fake microphone).
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] });

const composer = (page) => page.locator('textarea[aria-label^="Message"]');

async function openServerSettings(page, tab) {
  await page.locator('.ly-server-title').click();
  await page.getByRole('menuitem', { name: /Server settings/ }).click();
  await page.getByRole('tab', { name: new RegExp(tab) }).click();
}
const closeModal = (page) => page.getByRole('dialog').last().getByRole('button', { name: 'Close' }).click();

async function createFromTemplate(page, template, name) {
  await page.getByRole('button', { name: 'Create or join a server' }).click();
  await page.getByRole('button', { name: /Start from a template/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(template) }).click();
  await page.getByLabel('Server name').fill(name);
  await page.getByRole('button', { name: 'Create server' }).click();
  await expect(page.locator('.ly-server-title')).toContainText(name, { timeout: 30_000 });
}

/** A datetime-local value `minutes` from now, in the browser's time zone. */
const localIn = (page, minutes) => page.evaluate((m) => {
  const d = new Date(Date.now() + m * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}, minutes);

test('templates, welcome screen and the rules gate', async ({ users }) => {
  const alice = await users('alice');
  await createFromTemplate(alice, 'Hackathon', 'Hack Night');
  const side = alice.locator('.ly-sidebar');
  for (const ch of ['general', 'announcements', 'schedule', 'find-a-team', 'help-desk', 'submissions', 'stage', 'mentor-room', 'hack-workspace']) {
    await expect(side.locator('.ly-chan-name', { hasText: new RegExp(`^${ch}$`) })).toBeVisible();
  }
  for (const cat of ['Info', 'Hacking', 'Support']) await expect(side.locator('.sx-cat-head', { hasText: cat })).toBeVisible();
  await expect(alice.locator('.msg-text', { hasText: 'Welcome hackers!' })).toBeVisible({ timeout: 20_000 });
  // The owner wrote the welcome screen: no modal for her, but the composer offers the rules.
  await expect(alice.getByRole('dialog')).toHaveCount(0);
  await expect(alice.getByRole('button', { name: 'Server rules' })).toBeVisible();

  await openServerSettings(alice, 'Roles');
  for (const r of ['Organizer', 'Mentor', 'Hacker']) await expect(alice.getByRole('dialog').getByText(r, { exact: true }).first()).toBeVisible();
  await alice.getByRole('tab', { name: /Welcome/ }).click();
  await expect(alice.getByLabel(/Welcome message/)).toHaveValue(/Welcome to the hackathon/);
  await expect(alice.getByRole('checkbox', { name: /Require members to accept/ })).toBeChecked();
  // The welcome text is encrypted in the database.
  expect(JSON.stringify(await adminGet('sconf'))).not.toContain('hackathon');

  // Save as template, then find it in the create flow.
  await alice.getByRole('tab', { name: /Template/ }).click();
  await alice.getByLabel('Template name').fill('My hack template');
  await alice.getByRole('button', { name: 'Save as template' }).click();
  await expect(alice.getByText(/Template saved/)).toBeVisible();
  await expect(alice.locator('.cm-saved')).toContainText('My hack template');
  expect(JSON.stringify(await adminGet('udata'))).not.toContain('mentor-room');
  await closeModal(alice);
  await alice.getByRole('button', { name: 'Create or join a server' }).click();
  await alice.getByRole('button', { name: /Start from a template/ }).click();
  await alice.getByRole('dialog').getByRole('button', { name: /My hack template/ }).click();
  await expect(alice.getByLabel('Server name')).toHaveValue('Hack Night');
  await closeModal(alice);

  // A new member: welcome modal, gated composer, refused post, accept, then posting works.
  const link = await makeInvite(alice);
  const bob = await users('bob');
  await joinServer(bob, link, 'Hack Night');
  const modal = bob.getByRole('dialog', { name: 'Welcome to Hack Night' });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Teams of up to four people.');
  await modal.getByRole('button', { name: 'Not now' }).click();
  const notice = bob.getByRole('region', { name: 'Accept the rules to post' });
  await expect(notice).toBeVisible();
  await send(bob, 'hello before accepting');
  await expect(bob.locator('.chat-toast')).toContainText('Accept this server’s rules');
  await expect(composer(bob)).toHaveValue('hello before accepting');
  expect(JSON.stringify(await adminGet('messages'))).not.toContain(await uid(bob));

  await notice.getByRole('button', { name: 'Review and accept the rules' }).click();
  await bob.getByRole('dialog', { name: 'Welcome to Hack Night' }).getByRole('button', { name: 'I accept the rules' }).click();
  await expect(notice).toHaveCount(0);
  await composer(bob).press('Enter');
  await expect(alice.locator('.msg-text', { hasText: 'hello before accepting' })).toBeVisible();
  const accepted = await adminGet('sitems');
  expect(JSON.stringify(accepted)).toContain(`"by":"${await uid(bob)}"`);
});

test('events: /event, announcement card, RSVP, sidebar, panel, reminder, edit and cancel', async ({ users }) => {
  const alice = await users('alice');
  await createFromTemplate(alice, 'Friends', 'Event Club');
  await expect(alice.locator('.ly-sidebar .cm-side')).toContainText('No upcoming events');

  await composer(alice).fill('/event Launch party');
  await composer(alice).press('Enter');
  const editor = alice.getByRole('dialog', { name: 'New event' });
  await expect(editor.getByLabel('Title')).toHaveValue('Launch party');
  await editor.getByLabel('Starts').fill(await localIn(alice, 8));
  await editor.getByLabel(/^Ends/).fill(await localIn(alice, 90));
  await expect(editor.getByRole('combobox', { name: 'Voice channel' })).toHaveValue(/.+/);
  await editor.getByLabel(/Description/).fill('Cake at the voice channel');
  await editor.getByRole('checkbox', { name: /Announce it in #general/ }).check();
  await editor.getByRole('button', { name: 'Create event' }).click();
  await expect(editor).toHaveCount(0);

  const card = alice.locator('.msg .cm-event', { hasText: 'Launch party' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('hangout');
  await expect(alice.locator('.ly-sidebar .cm-next')).toContainText('Launch party');
  expect(JSON.stringify(await adminGet('sitems'))).not.toContain('Launch party');

  const link = await makeInvite(alice);
  const bob = await users('bob');
  await joinServer(bob, link, 'Event Club');
  // Bob has desktop alerts on but is in Do Not Disturb: count desktop notifications instead of showing them.
  const bobUid = await uid(bob);
  await adminPut(`notifPrefs/${bobUid}/settings`, { desktop: true, preview: true, mentionsOnly: false });
  await bob.evaluate(() => {
    window.__notes = [];
    window.Notification = class {
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
      constructor(title) { window.__notes.push(title); }
      close() {}
    };
  });
  await adminPut(`udata/${bobUid}/status/mode`, 'dnd');
  await expect(bob.getByRole('button', { name: /^Status: .*Change status$/ })).toHaveAccessibleName(/Do not disturb/);
  const bobCard = bob.locator('.msg .cm-event', { hasText: 'Launch party' });
  await bobCard.getByRole('button', { name: /^Going/ }).click();
  await expect(bobCard.getByRole('button', { name: /^Going/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('button', { name: /^Going/ })).toContainText('1');

  // Bob is going and the event starts within 15 minutes: the reminder card appears (tab open), but Do Not
  // Disturb keeps the desktop notification quiet.
  const reminder = bob.getByRole('region', { name: 'Reminder: Launch party' });
  await expect(reminder).toBeVisible({ timeout: 20_000 });
  await bob.waitForTimeout(1000);
  expect(await bob.evaluate(() => window.__notes)).toEqual([]);
  // "Join voice" joins the event's voice channel and opens its call view, like clicking the channel.
  await reminder.getByRole('button', { name: /Join voice/ }).click();
  await expect(bob.getByRole('region', { name: 'Call' })).toBeVisible({ timeout: 30_000 });
  await expect(reminder).toHaveCount(0);
  await bob.getByRole('region', { name: 'Call' }).getByRole('button', { name: 'Leave call' }).click();
  await expect(bob.getByRole('region', { name: 'Call' })).toHaveCount(0);
  await bob.reload();
  await expect(bob.locator('.msg .cm-event', { hasText: 'Launch party' })).toBeVisible({ timeout: 30_000 });
  await expect(bob.getByRole('region', { name: 'Reminder: Launch party' })).toHaveCount(0); // fires once

  // The events panel lists it; the organizer edits and then cancels it; members see the changes live.
  await alice.getByRole('button', { name: 'Events', exact: true }).click();
  const panel = alice.getByRole('complementary', { name: 'Events' });
  await expect(panel.getByRole('tab', { name: /Upcoming \(1\)/ })).toBeVisible();
  await panel.locator('.cm-event').getByRole('button', { name: 'Edit' }).click();
  const edit = alice.getByRole('dialog', { name: 'Edit event' });
  await edit.getByLabel('Title').fill('Launch party v2');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(bob.locator('.msg .cm-event', { hasText: 'Launch party v2' })).toBeVisible();
  await panel.locator('.cm-event').getByRole('button', { name: 'Cancel event' }).click();
  await expect(bob.locator('.msg .cm-event', { hasText: 'Launch party v2' })).toContainText('Cancelled');
  await expect(bob.locator('.ly-sidebar .cm-side')).toContainText('No upcoming events');
});

test('AutoMod blocks and hides; discovery lists, joins through the invite flow and unlists', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Public Lounge');

  await openServerSettings(alice, 'AutoMod');
  await expect(alice.getByText("AutoMod runs in members' browsers.")).toBeVisible();
  await alice.getByLabel(/Blocked words and phrases/).fill('spam*\nbuy now');
  await alice.getByLabel('Try a message').fill('SPAMMER here');
  await expect(alice.getByText(/Blocked: it contains a word/)).toBeVisible();
  await alice.getByRole('button', { name: 'Save AutoMod' }).click();
  await expect(alice.getByText('AutoMod saved')).toBeVisible();
  expect(JSON.stringify(await adminGet('sconf'))).not.toContain('spam');

  await alice.getByRole('tab', { name: /Discovery/ }).click();
  await expect(alice.getByText('Listing publishes an invite.')).toBeVisible();
  await alice.getByLabel('Description').fill('A friendly lounge for night owls');
  await alice.getByLabel(/Tags/).fill('chat, Night Owls');
  const listBtn = alice.getByRole('button', { name: 'List in Discover' });
  await expect(listBtn).toBeDisabled();
  await alice.getByRole('checkbox', { name: /I understand/ }).check();
  await listBtn.click();
  await expect(alice.getByText(/Listed in Discover/)).toBeVisible();
  const pub = await adminGet('pub/servers');
  const sid = Object.keys(pub)[0];
  expect(pub[sid]).toMatchObject({ name: 'Public Lounge', tags: 'chat,night-owls', members: 1 });
  await closeModal(alice);

  const bob = await users('bob');
  await bob.getByRole('button', { name: 'Create or join a server' }).click();
  await bob.getByRole('button', { name: /Discover public servers/ }).click();
  const discover = bob.getByRole('dialog', { name: 'Discover servers' });
  await discover.getByPlaceholder(/Search by name/).fill('night owls');
  await expect(discover.locator('.cm-listing')).toHaveCount(1);
  await discover.getByRole('button', { name: 'night-owls', exact: false }).first().click();
  await discover.getByRole('button', { name: 'Join Public Lounge' }).click();
  await bob.getByRole('button', { name: 'Accept invite' }).click();
  await expect(bob.locator('.ly-server-title')).toContainText('Public Lounge', { timeout: 30_000 });

  // AutoMod (block): the sender's app refuses and explains; the text stays in the composer.
  await send(bob, 'I am a spammer');
  await expect(bob.locator('.chat-toast')).toContainText('AutoMod blocked this message');
  await expect(composer(bob)).toHaveValue('I am a spammer');
  await composer(bob).fill('');
  await send(bob, 'hello lounge');
  await expect(alice.locator('.msg-text', { hasText: 'hello lounge' })).toBeVisible();

  // AutoMod (hide): sent, but readers see it collapsed until they reveal it.
  await openServerSettings(alice, 'AutoMod');
  await alice.getByRole('radio', { name: /hide it for readers/ }).check();
  await alice.getByRole('button', { name: 'Save AutoMod' }).click();
  await expect(alice.getByText('AutoMod saved')).toBeVisible();
  await closeModal(alice);
  await expect.poll(async () => {
    await composer(bob).fill('buy now please');
    await composer(bob).press('Enter');
    return composer(bob).inputValue();
  }, { timeout: 15_000 }).toBe('');
  const hidden = alice.locator('.msg', { has: alice.locator('.cm-am') });
  await expect(hidden.locator('.cm-am')).toContainText('Hidden by AutoMod');
  await expect(hidden.locator('.msg-text')).toBeHidden();
  await hidden.getByRole('button', { name: 'Show message' }).click();
  await expect(hidden.locator('.msg-text')).toHaveText('buy now please');
  await expect(bob.locator('.msg', { hasText: 'buy now please' }).locator('.cm-am')).toContainText('hides this message from other members');

  // Unlist: the listing and its invite go away together.
  const iid = pub[sid].iid;
  expect((await adminGet(`servers/${sid}/invites`))[iid]).toBeTruthy();
  await openServerSettings(alice, 'Discovery');
  await alice.getByRole('button', { name: 'Unlist' }).click();
  await alice.getByRole('button', { name: 'Really unlist?' }).click();
  await expect(alice.getByText(/Unlisted/)).toBeVisible();
  expect(await adminGet(`pub/servers/${sid}`)).toBeNull();
  expect((await adminGet(`servers/${sid}/invites`) || {})[iid]).toBeUndefined();
});
