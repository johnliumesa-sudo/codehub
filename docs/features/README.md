# Round 3 feature docs

One file per workstream. Feature numbers match the list in the main [README](../../README.md#round-3-features).

| Doc | Features |
|---|---|
| [bots.md](bots.md) | 1 Slash commands and built-ins · 2 Bot builder and public directory · 3 Bots in servers |
| [addons.md](addons.md) | 4 Add-on builder and public directory · 5 Personal add-ons panel and bridge · 6 Server add-ons |
| [assistant.md](assistant.md) | 7 Assistant setup · 8 Assistant panel · 9 Catch me up · 10 Message AI actions · 11 Writing help and `/ask` |
| [calls.md](calls.md) | Calls reliability fix (not numbered) · 12 Device settings and test · 13 Push-to-talk and speaking indicators · 14 Raise hand and call reactions · 15 Spotlight, fullscreen and picture-in-picture |
| [messaging.md](messaging.md) | 16 Voice messages · 17 Reminders · 18 Message links and jump · 19 Run code snippets · 20 Chat export · 21 Drafts |
| [personal.md](personal.md) | 22 Custom status, Do Not Disturb and auto-idle · 23 Favorites and server folders · 24 Private user notes · 25 Appearance settings |
| [community.md](community.md) | 26 Server events with RSVP · 27 Server templates · 28 Welcome screen and rules gate · 29 Server discovery · 30 AutoMod (client-enforced) |
| [shop.md](shop.md) | 31 Community shop: creator items and earnings |
| [sec-misc.md](sec-misc.md) | Security fixes from the round 3 review: size and rate limits on the generic blocks, AutoMod matching, discovery key warning, call slot grace, assistant names and sharing, bot welcomes |

Most workstreams live in `src/features/<ws>/`; calls and the shop mainly extend existing code (`src/lib/calls/`,
`src/components/calls/`; `src/lib/shop.js`, `src/lib/addons/`, `src/components/shop/`). The extension points,
generic rules blocks and helpers they build on are described in
[ARCHITECTURE.md, "Round 3: extension points"](../../ARCHITECTURE.md#round-3-extension-points).

Each file covers, per feature:

- **Purpose**: what the user can do, and where it appears (registry entries used).
- **Data paths**: every database path written or read (`udata`/`upub`/`sconf`/`sitems`/`pub` feature
  names and keys, or any new path), with its shape.
- **AAD strings**: every `<kind>:{sid}/{id}` / `<kind>:{uid}/{key}` used with `sealForServer` /
  `sealForMe` (kinds are unique across features).
- **Security notes**: what is end-to-end encrypted and what is plaintext by design, who can read and
  write what, and how untrusted data (other users' items, message body extras, published code) is
  validated and rendered.
- **Limits**: caps the rules enforce and caps only the UI enforces, plus rule bytes used.
