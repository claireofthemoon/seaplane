# Seaplane

An open settings app for the ROLI Seaboard M (formerly Seaboard Block M) and other
ROLI BLOCKS devices. It runs in the browser and talks to the keyboard over MIDI, so it
doesn't need ROLI's software or servers.

**Status:** a working control panel (`index.html`) for every setting the keyboard reports,
tested on a Seaboard M with firmware M1.4.3. `probe.html` is a read-only diagnostics page.

Controls behave like hardware: drag knobs up or down (Shift for fine), scroll, or use the
arrow keys, and double-click to return to the factory value. Each change is sent once, when
you let go, with the same `setConfig` message ROLI Dashboard uses, and then read back from
the keyboard to confirm it. "Revert to start" puts back the values from when you connected,
and settings can be saved to and loaded from a file.

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
- `js/controls.js`, `css/seaplane.css`: the knobs, switches, selectors and theme
- `js/config-items.js`: setting IDs, names and ranges, generated from ROLI's source by
  `tools/gen-config-items.py`
- `tests/`: `npm test` runs the protocol tests; `tests/fake-seaboard.js` is a fake
  Web MIDI device, used by `tests/browser-smoke.js` (Playwright)

Settings of interest for pitch: Piano Mode (17), Glide Rate (18), Glide Lock Enable (19),
Glide Sensitivity (11), Pitch Bend Range (3).
