# Calls (round 3)

Workstream `calls`: call reliability, device settings, push-to-talk and speaking indicators, raise hand
and reactions, spotlight / fullscreen / picture-in-picture. Calls are the WebRTC full mesh (up to 6
people) described in ARCHITECTURE.md "Calls"; this file covers what round 3 changed and added.

Code: `src/lib/calls/` (`core.js` database and signaling, `mesh.js` the `CallSession`, `health.js` pure
reliability logic, `events.js` in-call events, `prefs.js` local preferences, `media.js`, `useCall.js`),
`src/components/calls/` (`CallView`, `CallTile`, `DeviceForm`, `VoiceSettings`, …) and
`src/features/calls/index.js` (registry entries). Tests: `tests/unit/calls.test.mjs`,
`tests/rules/calls.test.mjs` ("heartbeat and ghost slots"), `tests/e2e/44-calls.spec.mjs` (plus the
older `30-calls.spec.mjs`). The browser tests kill a peer's `RTCPeerConnection` on each side, block
all ICE candidates on one side ("Couldn’t connect", retries, then recovery once unblocked), close,
crash and stall a tab (ghost slot removed; the stalled tab rejoins), hang the camera in a video call,
and exercise every feature below in two real browsers.

## Reliability (fix for "connecting… then cuts")

**Purpose.** Calls recover by themselves from network trouble, and a peer that can't connect says so
instead of sitting at "Connecting…".

- **Recovery per peer** (`health.js` `stepPeerHealth`, run by a 1 s watchdog in `mesh.js` and on every
  connection state change):
  - `failed` (ICE or connection state): ICE restart at once; `disconnected` for more than 4 s: ICE
    restart. The impolite side (lower uid) leads; the polite side does the same 5 s later only if the
    connection is still down (perfect negotiation resolves collisions). ICE restart uses
    `pc.restartIce()` (fallback `createOffer({ iceRestart: true })`).
  - A connection that never came up within 12 s, whose negotiation is stuck, whose
    `RTCPeerConnection` was closed under it, or that is still down after 3 ICE restarts in a row is
    replaced by a fresh `RTCPeerConnection` (new DTLS + ICE).
  - Backoff between attempts: 2, 4, 8, 16, then every 30 s. Attempts never stop while both people are
    in the call; the cap is on consecutive ICE restarts (3) before starting fresh.
  - Each fresh connection has a generation number per peer. Every signal carries `g` (sender's
    generation), `rg` (the receiver's generation it addresses), `tj` (the receiver's slot `joinedAt`) and
    `s` (a random tag per slot the sender claimed). Old generations, signals for an earlier slot, and
    answers meant for a replaced connection are dropped; a newer remote generation makes the receiver
    start fresh too (`classifySignal`, unit-tested with both sides restarting at once).
- **Status on tiles**: "Connecting…" (never connected yet), "Reconnecting…", "Connected" (green dot,
  text for screen readers), and after 20 s down "Couldn’t connect — this network may need a TURN relay"
  (retries continue). The people list shows the same.
- **ICE servers**: `stun:stun.l.google.com:19302` and `stun1`..`stun4` (one entry), plus up to 4 TURN
  entries from `appConfig/turn` (admin panel), validated (`stun:`/`turn:`/`turns:` URLs only).
- **Heartbeat**: my slot's `hb` is set to server time when I join and every 15 s. When my database
  connection drops, the server sets `hb` to 0 (`onDisconnect`) instead of deleting the slot, so a short
  network blip no longer ends anyone's call; on reconnect the client re-arms it and beats at once.
- **Ghost slots**: a slot whose `hb` is more than 45 s old (frozen or crashed tab whose connection the
  server still thinks is open), or that is offline (`hb` = 0) while nobody has a working media path to
  it for 6 s, is treated as gone: peers close it, hide the tile and remove the slot (the rules allow any
  member of the conversation to remove such a slot). The participant lists in headers and voice
  channels also hide and remove slots with an old heartbeat, and offline ones after 20 s. Joining or
  starting a call first removes ghost slots, so a call left behind by crashed tabs rings again. A
  client never judges others while its own copy may be out of date: not while it is offline, and not
  for 5 s after reconnecting or after its own tab was stalled (the rules would refuse a wrong removal
  anyway, since they compare `hb` with the server clock).
- **Rejoin**: if my slot disappears while my connection was down or my tab was frozen, the session
  claims a new slot by itself (at most 4 times in 2 minutes) and every peer reconnects. If it was
  removed while I was online and beating (someone allowed to do so removed it), the call ends.
- **Audio never waits for video**: in a video call the camera starts in the background; the call joins
  and connects with audio at once and adds the camera when it is ready (a camera that never answers
  just stays "Camera starting…", and clicking the camera button cancels it).
- **Leaving** removes the slot and my signaling inbox before anything is awaited (on `pagehide` only
  synchronous work reaches the network; the old code awaited an `onDisconnect` cancel first and left a
  ghost slot when a tab was closed). The inbox is no longer removed on disconnect, so signals sent
  during a blip are still there afterwards; leftovers are cleared on the next join or leave and are
  ignored anyway (older than the sender's slot, or addressed to an older slot).

**Data paths.** `calls/{scope}/slots/{i}/hb` and `vcalls/{sid}/{cid}/slots/{i}/hb`: number, server
time (`now`) or `0`. Optional, so slots of older clients (no `hb`) stay valid; they are never treated
as ghosts and others can't remove them (their `onDisconnect` still removes them).

**Rules.** In both slot blocks: `hb` validates as `now` or `0`; a member of the conversation (DM/group
member, server member for voice channels) may delete another member's slot when its `hb < now - 45000`
(0 included). The new clause comes last in the delete condition, so a slot without `hb` behaves exactly
as before. A dangling `onDisconnect` (`hb` = 0) after the slot was removed or taken over by someone
else is refused when it runs (a bare `hb` fails validation; tested). Rule bytes: +184 (minified total
98,341 of 102,400).

## 12. Device settings & test

**Purpose.** Settings → "Voice & video" (`userSettingsTabs` id `voice`; also palette action "Voice &
video settings") and the in-call gear menu: microphone, camera and speaker pickers
(`enumerateDevices`; speaker via `setSinkId` where supported, otherwise a note), a live microphone
level meter (`role="meter"`), "Test microphone", "Preview camera", "Play test sound" (on the chosen
speaker), echo cancellation / noise suppression / automatic gain switches, and the push-to-talk
settings. Changes during a call are applied at once: a new microphone or processing setting re-captures
the mic and swaps it into every connection with `replaceTrack` (no renegotiation), a new camera does the
same for video, a new speaker re-targets the remote audio elements.

**Data.** Local only: `localStorage['codehub.callDevices']` = `{ audioIn, videoIn, audioOut, ec, ns,
agc, ptt, pttKey }` (the key the first calls release used for device ids; old values are kept).
Normalized on read (`prefs.js`). Nothing is written to the database.

## 13. Push-to-talk & speaking indicators

**Purpose.** With push-to-talk on (settings, or palette "Toggle push-to-talk"), the microphone track
is enabled only while the key is held (default backquote, any key except Esc, Tab, Enter, Backspace,
Caps Lock, Meta; Ctrl/Alt/Meta combinations are ignored) in the focused tab, or while the "Hold to
talk" button is pressed (pointer, touch, Space/Enter). Typing the key in a text field does not open the
mic; releasing happens on key up, window blur and when the tab is hidden. The call header shows "Push-to-talk:
hold `" / "Talking". The mute button still mutes completely.

Speaking rings (green ring on the tile and avatar, highlighted row in the people list and voice
channel list) come from Web Audio analysis of my own outgoing track and each remote audio track in this
browser; nothing about speaking is sent over the network.

## 14. Raise hand & call reactions

**Purpose.** "Raise hand" toggles ✋ on my tile and in everyone's people list, ordered by time
(earliest first, numbered on the tiles); reactions (👍 ❤️ 😂 🎉 👏 😮 😢 🔥) float over the sender's tile
for 3 s (fade only with reduced motion). Raised hands and joins/leaves are announced in a polite live
region. Palette action "Raise or lower hand".

**Transport.** One negotiated `RTCDataChannel` per peer (`codehub-events`, id 0), so events are
end-to-end encrypted by DTLS and never stored. Messages are JSON `{t:'hand', up, at}`,
`{t:'react', e}`, and `{t:'state', hand:{up, at}}` (sent when a channel opens, so people joining or a
reconnected peer see current hands). `at` is the sender's server-corrected clock; values more than 10
minutes off are replaced by the receiver's.

**Security.** Everything received is validated (`parseCallEvent`): at most 200 characters, known `t`,
boolean `up`, reactions only from the fixed list, rendered as React text. Per-sender token buckets:
8 events (refill 1 per 500 ms) and 5 reactions (refill 1 per 600 ms); my own reactions are limited to 4
(1 per 750 ms) with a "Slow down a little" note; hand toggles at most every 400 ms.

## 15. Spotlight, fullscreen & picture-in-picture

**Purpose.** Clicking a tile (a full-size button, keyboard accessible, `aria-pressed`) spotlights it:
large view plus a scrollable strip of the others; click again or "Back to grid" to return. "Full screen"
puts the call view in fullscreen (`requestFullscreen`). "Picture-in-picture" (shown when the browser
supports it and the spotlighted tile has video) pops the spotlighted video out. When someone else starts
a screen share it takes the spotlight automatically; an automatic spotlight ends with the share. A
people panel (header button) lists everyone with hands, mute and connection status.

## AAD strings

None new. Signaling keeps `call:{scope}/{callId}/{from}->{to}` (the new `g`, `rg`, `tj`, `s` fields are
inside the encrypted payload). Data channel events are protected by DTLS and are not stored.

## Plaintext by design

The heartbeat timestamp (when a participant's client was last alive) joins the existing plaintext call
metadata (who is in which call, mic/cam/screen flags).

## Limits

- Calls only run while the tab is open (Spark plan: no push, no media server). A frozen background tab
  drops out after 45 s and rejoins when it wakes.
- Some networks block direct connections; without an admin-configured TURN relay those peers show
  "Couldn’t connect" and keep retrying every 30 s.
- Push-to-talk works only while the tab is focused (browsers don't deliver keys to background tabs).
- Speaker selection needs `setSinkId` (Chromium; Firefox behind a setting; not Safari).
- Picture-in-picture needs `document.pictureInPictureEnabled` (not Firefox).
