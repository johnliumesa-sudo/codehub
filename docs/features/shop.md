# Shop: community items and creator earnings (round 3, feature 31)

The add-on shop used to be stocked only by app admins. Now any signed-in member can publish items, they go
live immediately, and the coins buyers pay go to the item's creator. Nothing here mints coins: every coin a
creator collects was paid by a buyer in the same database update that gave the buyer the item.

Code: `src/lib/shop.js`, `src/lib/addons/*` (validators, color helpers, editor-theme generator, earnings
helpers), `src/components/shop/*`. Rules: `shop`, `wallets`, `inventory`, `earnings` in `database.rules.json`.

## Purpose and UI

The shop (rail button "Add-on shop", or the palette's "Open shop") has three tabs.

- **Browse.** Official items (marked "Official") and community items ("by {creator}"). Filter by kind,
  "Owned only", search (name, description, creator name), sort (Featured, Newest, Price low/high). Clicking
  "by {creator}" shows only that creator's items. Buy / Get / Equip as before; the report button stays on
  every card. App admins also see "Take down" / "Restore" and "Delete" on community cards.
- **My items.** Create an item with a live preview (`ItemPreview`), edit, switch off / on, delete. Each row
  shows the item's sales count and its state: Live, Off, or "Taken down by an admin" (then the creator can
  only delete it). Items that no longer pass the client checks are listed as "Hidden" so their creator can
  delete them.
- **Earnings.** Uncollected total, all-time collected total, and one row per sale (item, buyer, time,
  price) with Collect; "Collect all" collects them one after another. Collecting needs a wallet (claim the
  starter coins first).

The Admin panel's "Shop catalog" lists official and community items (filter by source), uses the same form,
and can take down, restore or delete any item.

### What creators can publish

| Kind | Data | Notes |
|---|---|---|
| `theme` | `tokens`: app color tokens (`bg0`…`danger`), `#rrggbb` | Text must reach 4.5:1 on `bg1`/`bg2`/`bg3`, dim text 3:1, accent 2:1 |
| `editorTheme` | `tokens`: `bg fg sel caret kw str cmt num fn type op`, `#rrggbb`, all eleven | First-party generator (`editorPalette.js` → `editorThemes.js#editorThemeFromTokens`) builds the CodeMirror theme. Foreground 4.5:1 on background; syntax colors and cursor 2:1; selected text 2:1 |
| `badge` | `glyph`, 1–8 characters of plain text | Rendered as React text |
| `nameColor` | `color`, `#rrggbb` | |

`editorExt` items and editor themes that name a bundled module (`builtinId`) stay admin-only: they select
first-party code. Name ≤ 48, description ≤ 280, price 0–10000 whole coins.

## Data paths

```
shop/items/{itemId}        { name, desc, kind, price, data, active, updatedAt (= now), updatedBy (= me),
                             by?: creator uid, createdAt?: now at creation }      signed-in read
wallets/{uid}              { balance, lastClaim, lastItem?, lastEarn? }           owner read/write, never deleted
inventory/{uid}/{itemId}   { at, price }                                           owner read, create-once
earnings/{creator}/{buyerUid}_{itemId}   { price, ts (= now) }                     creator reads and deletes
publishLog/{uid}           now                     the existing 60 s publish window, shared with games
udata/{uid}/shop/last      itemId                  binds one new item to one publishLog stamp
udata/{uid}/shopSales/{buyerUid}_{itemId}   { item, price, at }   collected sales (sales counts, totals)
```

Community item ids are push keys (they start with `-`). Official items have no `by`; admin-created ones now
also get `createdAt`. Uids never contain `_`, so an earning key splits at its first `_`.

### Writes

- **Create (creator):** ONE update: `shop/items/{id}` (with `by` = me, `createdAt` = now), `publishLog/{me}`
  = now, `udata/{me}/shop/last` = id.
- **Edit (creator or admin):** `update()` of the item's own fields plus `updatedAt`/`updatedBy`; `by` and
  `createdAt` are never sent and never change.
- **Buy someone else's paid item:** ONE update: `wallets/{me}/balance` = balance − price,
  `wallets/{me}/lastItem` = id, `inventory/{me}/{id}` = `{at, price}`, and
  `earnings/{creator}/{me}_{id}` = `{price, ts}`. Free items and your own items create no earning. Official
  items work exactly as before.
- **Collect one sale:** ONE update: `wallets/{me}/balance` = balance + that entry's price,
  `wallets/{me}/lastEarn` = key, `earnings/{me}/{key}` = null, `udata/{me}/shopSales/{key}` = history row.
  The client re-reads and retries (at most three tries) if the balance moved in between.

## AAD strings

None. The shop is plaintext by design, like the rest of the economy (catalog, wallets, inventory,
equipped cosmetics).

## Security notes (what the rules enforce)

Items:
- Anyone signed in may create an item only with `by` = their uid, a push-key id, inside the shared 60 s
  `publishLog` window, and only the id stored in `udata/{me}/shop/last`. One update therefore creates at most
  one item. Non-admins can never write `data/builtinId` (no `editorExt`, no bundled editor themes).
- Only the creator edits or deletes a community item; app admins may write or delete any item. `by` never
  changes, is never added to or removed from an existing item (also not by an admin), and `createdAt` is set
  to `now` once and never changes.
- **Take-down sticks:** when the last writer of an inactive community item was not its creator (an admin
  switched it off), the creator can no longer edit or re-activate it, only delete it. An admin restores it.
- Shapes: kind ∈ the five kinds with the matching data child, colors `#rrggbb`, token keys from the two fixed
  lists, price integer 0–10000, no unknown fields.

Earnings (no minting, no double pay):
- An earning can only be created by the buyer (key starts with `{auth.uid}_`), and the key must be exactly
  `{auth.uid}_{itemId}` (a second spelling like `{me}_-x{me}_y` is refused). The item's `by` must be the
  creator in the path, the creator must not be the buyer, the price must equal the catalog price, `ts` = now,
  and the buyer's inventory entry for that item must not exist before the write and must exist after it. The
  inventory entry is create-once, so each (buyer, item) pair can produce at most one earning, ever.
- Existing earnings can't be modified by anyone; only their creator can delete them.
- Collecting: the wallet may grow by exactly `earnings/{me}/{lastEarn}/price` of an entry that existed before
  the write and is deleted in the same write, with `lastClaim` unchanged. One wallet write can be a claim, a
  purchase or a collect, never two at once. Nobody else can read or touch your earnings or wallet.
- Every one of these cases has a rules test (`tests/rules/shop.test.mjs`), and each guard was mutation-tested:
  removing it makes at least one test fail.

Client-side checks (on create, on edit, and again on every render of a community item):
`findForbidden` (no links, domains, markup or CSS/JS-looking text) on name and description,
`sanitizeItemInput` / `normalizeItem` shape checks, and a readability check for app and editor themes. A
community item that fails is hidden and never applied. Item text renders as React text; colors reach the page
only as validated hex values through the fixed token map or the CodeMirror theme builder.

Privacy: earning keys contain the buyer's uid, so a creator sees who bought their items (the shop says so
before you buy). Earnings and wallets are private to their owner but not end-to-end encrypted. Items whose
creator deleted their account are no longer listed for new buyers.

## Limits

| Limit | Enforced by |
|---|---|
| One new item per minute per user (shared with game publishing) | rules (`publishLog`) |
| One new item per update | rules (`udata/{me}/shop/last`) |
| 50 community items per creator | client (the rules can't count children); the shop lists at most a creator's 50 oldest items, so a modified client can't flood it |
| Price 0–10000, name ≤ 48, description ≤ 280, glyph ≤ 8 | rules + client |
| Readable themes (contrast) | client (create, edit, render) |
| "Popular" sort | not offered: sales are private to each creator, so there is no cheap public sales count |

Rule bytes: 1,474 of the 1,500-byte budget (minified rules 99,631 bytes after this change, from 98,157).

Account deletion (`src/lib/account.js`, integration pass) removes the user's community items in
`shop/items` and their uncollected `earnings/{uid}/*`, one entry at a time (the rules allow each), along
with `udata/{uid}` (sales history, `shop/last`). Coins already collected stay in `wallets/{uid}` and
`publishLog/{uid}` stays, as before: no client can delete those.
