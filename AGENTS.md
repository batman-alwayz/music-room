# Music Room — notes for agents

Cloudflare Worker backend (`src/`) + a static front-end in `public/`. No build step: the browser loads
`public/*.js` as ES modules directly.

## Commands

- `npm test` — Node's test runner over `test/*.test.js` (sync, theme, vinyl).
- `npm run check` — `node --check` on every `public/*.js`.
- There is no dev server script. To exercise the UI end-to-end, point a static server plus an
  `/api` mock at `public/` and open it with a room hash like `#r=ABC123`.

## Layout of the front-end

- `public/app.js` — the whole room screen: WebSocket state, render, playback clock, design wiring.
- `public/vinyl.js` — the record. Pure canvas; the pixel body is cached per shape+theme.
- `public/theme.js` — pure colour maths, no DOM. Three themes (`buildAppTheme`, `buildLyricsTheme`,
  `buildDiscTheme`) each derived from one colour. Unit-tested directly under Node.
- `public/spotify.js` — the Spotify Web API wrapper (`spApi`, `connect`, `bestDevice`).
- `public/sync.js` — the room clock (`serverNow`, `setOffset`).

## Things worth knowing before you change them

- **Three independent themes.** The app, lyrics and disc themes must not leak into each other. The
  lyrics theme owns its own `panel`/`line` (it does *not* borrow the app panel), so recolouring the
  app never shifts the lyric colours. `test/theme.test.js` asserts this — keep it green.
- **One playback clock.** `songMs()` in `app.js` is the single source of playback position. It prefers
  Spotify's own position while Spotify is the source (with a freshness guard against stale reads) and
  falls back to the room clock otherwise. Route every progress/lyric/seek decision through it.
- **Cross-device.** `observeSpotifyState()` must honour a play/pause/seek made on *any* device, not
  just when this browser is the active Spotify player. Do not re-add a gate that requires the local
  browser to be the player.
- **The disc's fit.** `fit()` scales the canvas so the disc edge lands exactly on the round frame,
  using `DISC_REACH` (the measured distance each shape reaches from the centre, in disc px). If you
  change the drawing constants, re-measure the reach rather than guessing.
- **The spin.** It eases to a stop on pause and snaps the last sliver to zero (`speed < 0.004`), so a
  paused record is truly still. Exponential easing alone never reaches zero and creeps forever.

## Testing in the browser

The unit tests cover the pure modules. Anything touching the DOM (disc fit, spin, layout, theme
application) needs a real browser: serve `public/` with a mock `/api` and drive it over the CDP. Assert
on measured geometry and pixels, not on "it looks right".
