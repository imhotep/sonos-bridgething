# Building this bridgething webapp

You are helping build a **bridgething webapp**: a single-page web UI for the
Spotify Car Thing. It runs full-screen in a chromium kiosk on the device and
talks to the on-device daemon over a local WebSocket using `@bridgething/client`.
This file is always loaded; it holds the constraints. The `/bridgething` skill
goes deep on the how-to: the client API, running and driving the app, and
shipping it.

## The device you are targeting

- **Screen: 800x480, landscape.** Fixed. Design for exactly this. The window
  never resizes; there is no responsive breakpoint to chase.
- **One page.** The kiosk shows exactly one webapp at a time. In-app views are
  fine, but there are no browser tabs, popups, or second windows.
- **Physical controls arrive as ordinary browser events.** Listen with a
  `keydown` handler and a `wheel` handler on `window`.
  - Preset buttons **1 2 3 4** -> `keydown` key `"1"` `"2"` `"3"` `"4"`.
  - **Mode** button -> `keydown` key `"m"`. (Pressing it 5 times fast is a
    system gesture that jumps back to the launcher, so do not build anything
    that depends on rapid repeated `m`.)
  - **Back** button -> `keydown` key `"Escape"`.
  - **Rotary wheel** -> horizontal scroll: `wheel` events with `deltaX`. This is
    the primary way users move through lists; make horizontal wheel scroll work.
  - **Touch** works normally (pointer/touch events).
- **No keyboard, no mouse.** Those five controls plus touch are the whole input
  surface. There is no text entry unless you build an on-screen one.

## The SDK: `@bridgething/client`

```ts
import { BridgethingClient } from '@bridgething/client';
const client = new BridgethingClient(); // auto-connects to the daemon, auto-reconnects
```

Construct it once and reuse it. It defaults to the on-device daemon; in dev you
point it at your device with `VITE_BRIDGETHING_URL` (the starter `App.tsx`
already does this). Do not hardcode a WebSocket URL.

It is fully typed with a doc comment on every surface, method, and field. Read
those declarations directly - you have no editor to hover in:

- `node_modules/@bridgething/client/dist/dispatch.generated.d.ts` - every
  `client.<surface>.<method>` and event, with docs.
- `node_modules/@bridgething/lib/dist/bindings/*.d.ts` - the payload and reply
  types (`PlayerState`, `MediaItem`, ...), with per-field docs.

18 surfaces: `player asset config store capabilities library audio notifications
phone geo net hardware bluetooth system time voice webapp forward`. Each method
is one of three shapes:

- **events**: `client.<s>.onXxx(handler)` returns an unsubscribe fn; or
  `client.<s>.subscribe({ onXxx, ... })`.
- **requests**: `await client.<s>.xxx(req)` returns `{ ok: true, response }` or
  `{ ok: false, kind, error }` - always check `.ok`.
- **commands**: `await client.<s>.xxx(payload)` returns `void` (fire-and-forget).

Now-playing and library data come from the **connected phone's** Spotify. Assume
a phone may not be connected: handle the empty/disconnected state gracefully (the
starter shows a "connect a phone" placeholder). Fetch artwork by opaque asset id
via `client.asset.get`; never build image URLs by hand.

Run `/bridgething` for the cookbook, the dev loop, and shipping; grep the `.d.ts`
files for a specific method or type.

## `manifest.json` (in `public/`)

- `id` - baked in at scaffold, unique to this project. **Never change it.**
- `name`, `version`, `description`, `icon` - cosmetic / store metadata.
- `config` - user-tunable settings (each becomes a `client.config` value).
- `permissions` - capabilities you need (e.g. `net.fetch`, `net.proxy`, `geo`).
- `art: { heroPx, thumbPx }` - the pixel sizes you want artwork delivered at.
- `settings` - one self-contained HTML file (built from `settings/`) the
  companion phone app renders as this webapp's settings page. It talks to the
  companion over `@bridgething/client/settings`, not the on-device SDK. Capped
  at 1 MiB at install. It loads from a `file://` origin: websocket APIs work
  from it, but plain HTTP fetch is CORS-gated (`Origin: null`) - see the
  network caveat in the `/bridgething` skill's sdk reference.

## Workflow

- `bun run dev` - vite dev server. Iterate here. Use `/bridgething` for the loop
  of seeing the screen and pressing the buttons.
- `bun run build` - production bundle into `dist/`.
- `bun run push` - build + install onto a connected Car Thing (see `/bridgething`).
- `bun run update` - update the connected device to the latest bridgething release
  (device firmware, not your webapp; see `/bridgething`).

## Do not

- Fight the 800x480 viewport or assume any other size.
- Hardcode `ws://...`; use the SDK default + `VITE_BRIDGETHING_URL`.
- Assume a phone is always connected.
- Build image URLs by hand; fetch by opaque asset id.
- Rely on rapid repeated `m` (system launcher gesture).
