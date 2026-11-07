# Premium membership (feature 32)

Members unlock premium for 30 days by redeeming the owner's **monthly code**. The owner manages codes and members
from a passcode-locked dashboard in the Admin panel. Everything runs on the free Spark plan: the database rules are
the only gatekeeper, there is no server and no payment integration (how the owner hands out codes is up to them).

Code: `src/features/premium/` (`index.js` registers the UI; `lib/status.js` is the shared status contract;
`lib/codes.js` and `lib/lookCore.js` are pure and unit-tested; `lib/premium.js` holds the Firebase actions; the
agent mode lives in `agent/` and is documented separately). Rules: `premium`, `premiumCodes`, plus small changes in
`wallets`, `inventory` and `shop/items` in `database.rules.json`.

## Purpose and UI

- **Settings → Premium** (`userSettingsTabs` id `premium`; palette "Open Premium settings"): status (active until,
  redeemed on), the redeem / renew form, "Leave premium", the perk list, and, while active, the **premium look**
  editor with a live preview.
- **Admin panel → Owner** (`adminTabs` id `owner`, app admins only): locked until the owner passcode is entered.
  Unlocked, it shows this month's and next month's code (large, Copy), **Generate codes**, **Replace this month's
  code** (with confirmation), all codes with their state, the member list (name, redeemed, expiry, Revoke, optional
  expired rows) and the **Database rules** panel. It locks again after 15 minutes or on **Lock**.
- **Perks**
  - Double daily coins: the shop's daily claim gives +200 instead of +100 (the first claim, which opens the wallet,
    stays 100). The button says "(+200, premium)".
  - Premium-only shop items: the item form (creators and app admins) has "Premium members only". The card shows a
    "Premium" tag; non-members see "Premium only" instead of Buy / Get.
  - Premium badge (a diamond) after the name in messages (`messageBadges` id `premium.badge`), server and group
    member lists, the profile card and the user panel.
  - Custom role tag: up to 24 characters (emoji count as one), one colour or a two-colour gradient.
  - Profile banners: aurora, animated gradient, starfield, or the standard banner with an animated frame.
  - Effects: name effects (gradient, glow, shimmer, rainbow), profile-card effects (sparkles, snow, confetti) and an
    avatar frame (glow, gradient, rainbow ring) on messages and the profile card.
  - Agent mode in codespaces: see the agent doc.

All animations stop when Settings → Appearance → Reduce motion is on (`html.ap-reduce-motion`) or the device asks for
reduced motion; card particles are then hidden. The pieces use the theme tokens and work in dark and light theme and
at phone width.

## Data paths

```
premium/{uid}              { at, until, m }        at = server now; until = now + 30 days (within the minute
                                                    before); m = 'YYYYMM' of the code redeemed
premiumCodes/{YYYYMM}      { c, from, until }      c = code (8–64 chars), from/until = UTC month start / next month start
promoAttempts/{uid}        { code, at }            existing: the last guess (code or passcode), 30 s per account
config/ownerPass           string ≥ 12 chars       set only in the Firebase console
upub/{uid}/premium/look    { tag?, tagA, tagB?, nameFx, fxA, fxB, cardFx, banner, frame }   generic public block
shop/items/{id}/premium    true                    optional: premium-only item
```

Codes look like `HXQ7-K4MW-TN3C`: 12 symbols from a 23-letter alphabet without look-alikes (no 0/O, 1/I/L, 2/Z,
5/S, 8/B, U/V), drawn with `crypto.getRandomValues` and rejection sampling (about 54 bits). The redeem form accepts
them in any case, with or without dashes or spaces.

### Writes

- **Redeem / renew** (member): `set(promoAttempts/{me}, { code, at: now })`, then `set(premium/{me}, { at: now,
  until, m })` for the month of the server clock; within 36 hours of a month boundary also the neighbouring month.
  `until` is computed from the server time offset, 10 s below now + 30 days.
- **Leave** (member) / **Revoke** (app admin): `remove(premium/{uid})`.
- **Unlock** (owner): `set(promoAttempts/{me}, { code: passcode, at: now })`, then a test read of `premiumCodes`.
  **Lock** overwrites the stored guess with random filler (after the 30 s cooldown if needed) so access ends before
  the 15 minutes are over.
- **Generate codes**: one multi-path update of `premiumCodes/{m}` for this month and the next 11 calendar months
  that have no code. **Replace**: `set(premiumCodes/{thisMonth})` with a fresh code (same window).
- **Daily claim**: `wallets/{me}` `{ balance + 200, lastClaim: now }` while premium; if refused (the membership just
  ended, or older rules are published) the client retries with +100.
- **Premium look**: `set(upub/{me}/premium/look)`; account deletion removes `upub/{me}` and `premium/{me}`.

## What the rules enforce

- `premium/{uid}`: signed-in users read one record; only app admins read the whole list. A **create or overwrite**
  is allowed only by `uid` itself, with `at = now`, `until` in `(now + 30 d − 60 s, now + 30 d]`, fields `at`,
  `until`, `m` only, `m` six digits, and:
  - `premiumCodes/{m}/c` equals `promoAttempts/{uid}/code`, written at most 2 minutes ago;
  - `premiumCodes/{m}/from <= now < premiumCodes/{m}/until` (expired and future months fail);
  - `m` differs from the stored record's `m` (renewal needs a later month's code; the same code can't be replayed to
    push `until` forward).
  A **delete** is allowed for `uid` itself and for app admins. Admins can't grant premium.
- `premiumCodes`: read and write only when `admins/{auth.uid}` exists, `config/ownerPass` is a string of at least 12
  characters, `promoAttempts/{auth.uid}/code` equals it and was written less than 15 minutes ago. Entries need
  `$m` = six digits, `c` 8–64 characters, numeric `from` and `until > from`, nothing else.
- `wallets`: a daily claim adds exactly 200 while `premium/{uid}/until > now`, else exactly 100.
- `inventory`: an item with `premium` set can be added (bought or taken free) only while `premium/{uid}/until > now`.
- `shop/items/{id}/premium`: `true` or absent; the existing item rules decide who may edit (creator or app admin).
- `config` stays unreadable and unwritable for every client.

## Threat model and security notes

- **Secrets.** The owner passcode and the codes exist only in the database (`config/ownerPass` is console-only,
  `premiumCodes` is owner-only) and in the browser of whoever types them. The client clears the input before the
  request, never logs, persists or echoes them in errors, and no secret appears in source, rules, docs or tests (tests
  generate random values at runtime). The Owner dashboard does show the codes on screen once unlocked: that is its job.
- **Guessing.** `promoAttempts` accepts one guess every 30 s per account, shared by the admin code, premium codes and
  the passcode. A premium code has about 2^54 possibilities; the passcode has at least 12 characters. Rate limiting
  is per account, so many throwaway accounts guess faster (still far from feasible).
- **Two factors for codes.** Being an app admin is not enough to see codes: an admin also needs the passcode. A
  stolen admin session without the passcode can only list and revoke memberships.
- **Shared codes.** A monthly code works for everyone who has it, during its month. A leaked code can be stopped with
  "Replace this month's code"; members who already redeemed keep their 30 days (revoke them individually).
- **Revoke is not a ban.** A revoked member who still has this month's code can redeem it again (their record is gone,
  so it is a first redemption). Replace the code if that matters.
- **Leave and redeem again.** A member who deletes their own record can redeem the same month's code again and
  restart 30 days from that moment, at most until 30 days after the month ends.
- **Cosmetics are untrusted.** Anyone can write `upub/{uid}/premium/look` (generic block); readers show it only
  while `premium/{uid}` is active, re-validate every field (`normalizeLook`: known effect names, `#rrggbb` colours,
  tag cleaned of control and bidi characters, at most 24 characters, no links or HTML) and render the tag as React
  text. Colours are applied through CSS custom properties only.
- **Clock.** Expiry uses the server clock on writes (rules `now`) and the server-corrected clock on reads
  (`isPremiumActive`). Month windows are UTC; near a boundary the client tries both months.
- **Database rules file.** The build emits the minified rules as `rules.min.json` next to `index.html` (Vite plugin in
  `vite.config.js`, also served by the dev server). Rules contain no secrets; the file is fetched only when the
  Database rules panel opens.
- **Older rules.** Until the new rules are published, `premium/*` reads are refused (everyone shows as non-premium),
  the dashboard explains that the passcode or rules are not set up, double coins fall back to +100, and the
  "premium only" flag can't be saved.

## Plaintext by design

Membership records (who is premium, when they redeemed, which month's code, until when) are readable by every
signed-in user so others can render perks. The premium look is public like the rest of `upub`. Codes and the
passcode are never readable by members.

## Limits

- 30 days per redemption; a new month's code renews (until = redemption + 30 days, not stacked).
- Codes: up to 12 months ahead per "Generate codes"; 8–64 characters (generated codes are 14).
- Role tag ≤ 24 characters (UI), upub strings ≤ 2000 (rules).
- Owner unlock: 15 minutes; one guess per 30 s per account.
- Rule bytes: premium adds about 1.8 KB to the minified rules; the minifier's new `isString()` guard drop saves about
  2.7 KB across the existing rules (full suite green on source and minified output, emulator probes in
  `tests/rules/premium.test.mjs`). Minified total with premium: 99,850 bytes.

## Tests

- Rules: `tests/rules/premium.test.mjs` (redeem right / wrong / expired / future / stale / no code / wrong shape;
  renew; delete own; admin revoke; list access; dashboard access with fresh passcode, after 15 minutes, wrong
  passcode, non-admins, short or missing passcode; malformed codes; config unreadable; double coins; premium-only
  purchases; the premium item flag; probes for the dropped `isString()` guards).
- Unit: `tests/unit/premium.test.mjs` (code generation and alphabet, normalization, UTC month windows, candidate
  months, code planning and replacement, look validation, the minifier's guard drop).
- E2E: `tests/e2e/52-premium.spec.mjs` (owner unlocks with a random passcode, generates and copies codes; a member
  redeems and gets the badge, tag, effects and double coins; a non-member's look shows nothing; premium-only item
  purchase; revoke; lock; the Database rules panel's size and Copy).
