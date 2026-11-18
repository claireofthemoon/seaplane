# Seaplane

An open settings app for the ROLI Seaboard M (formerly Seaboard Block M) and other
ROLI BLOCKS devices. It runs in the browser and talks to the keyboard over MIDI, so it
doesn't need ROLI's software or servers.

**Status:** step 1, a read-only probe. It connects, reads every setting the keyboard
reports, and makes a report. It does not change anything on the keyboard yet.

## Running it

Web MIDI with SysEx is needed, so use **Chrome, Edge or Firefox**. Safari doesn't support Web MIDI.

- **Chrome / Edge:** open `index.html` directly, or serve the folder.
- **Firefox:** serve the folder over `https` (e.g. GitHub Pages) or from `localhost`.
  Firefox asks you to install a small "site permission" add-on the first time; that is
  how Firefox grants MIDI access.

To serve locally: `npm run serve`, then open http://localhost:8000.

Connect over USB-C for the most reliable link. Bluetooth MIDI also works on macOS once the
keyboard is paired in Audio MIDI Setup → Window → Show MIDI Studio → Bluetooth.

## How it works

ROLI published its BLOCKS host protocol as open source
([roli_blocks_basics](https://github.com/WeAreROLI/roli_blocks_basics), ISC licence).
Every setting in ROLI Dashboard is a numbered "config item" sent as a SysEx message:

```
F0 00 21 10 77 <device index> <7-bit packed payload> <checksum> F7
```

The connection sequence matches ROLI's own host: serial request → topology request →
`endAPIMode` + `beginAPIMode` → ping every 400 ms → request all config.
Disconnecting sends `endAPIMode`, which returns the keyboard to normal standalone use.

- `js/blocks-protocol.js`: bit packing, checksum, packet builders and decoder
- `js/session.js`: the connection sequence
- `js/config-items.js`: setting IDs, names and ranges, generated from ROLI's source by
  `tools/gen-config-items.py`
- `tests/`: `npm test` runs the protocol tests; `tests/fake-seaboard.js` is a fake
  Web MIDI device for browser testing

Settings of interest for pitch: Piano Mode (17), Glide Rate (18), Glide Lock Enable (19),
Glide Sensitivity (11), Pitch Bend Range (3).
