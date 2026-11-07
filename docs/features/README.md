# Round 3 feature docs

One file per workstream: `bots.md`, `addons.md`, `assistant.md`, `calls.md`, `messaging.md`,
`personal.md`, `community.md`. The extension points, generic rules blocks and helpers they build on are
described in [ARCHITECTURE.md, "Round 3: extension points"](../../ARCHITECTURE.md#round-3-extension-points).

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
