# Sonos Control

A bridgething webapp for the Spotify Car Thing: control every Sonos room
(play / pause / stop, volume, grouping view) and fire your saved Sonos
favorites — including mixed S1 + S2 households.

## Install

Add this source URL in the bridgething companion app:

```
https://imhotep.github.io/sonos-bridgething/catalog.json
```

The app finds speakers automatically (subnet scan through the phone tunnel);
entering one speaker IP in the app's settings page makes startup faster.

## Develop

```bash
bun install
bun run dev
```

Opens at http://localhost:5173/ (`?demo` runs with fake data, no device). The
app connects to `ws://<host>/` (the daemon's local WebSocket on port 8891 of
the device itself). To dev against a remote device, set:

```bash
VITE_BRIDGETHING_URL=ws://<device-ip>:8891/ bun run dev
```

## Push to a device

```bash
bun run push
```

`push` builds `dist/`, streams it over ssh into
`/var/bridgething/webapps/<manifest-id>/` on the Car Thing, and switches the
kiosk to the app. Pass an IP address to target something other than
`bridgething.local` over USB.

## Publish

Pushing to `main` rebuilds the bundle and republishes the catalog to GitHub
Pages (`.github/workflows/publish.yml` → `scripts/publish-catalog.ts` →
`site/`). Bump `version` in `public/manifest.json` for a new release; never
change the `id`.

## Share a zip

```bash
bun run build
bun run share
```

`share` writes `<name>-<version>.zip` from `dist/`. Anyone with a bridgething
Car Thing installs it from the companion app.

## Update the device

```bash
bun run update
```

`update` runs [`@bridgething/updater`](https://www.npmjs.com/package/@bridgething/updater)
to bring the connected Car Thing to the latest bridgething release. Multiple devices: `bun run update -- --host ws://bridgething-<serial>.local:8892/`.

## Layout

- `src/App.tsx` - the whole UI: rooms, now playing, favorites, input handling.
- `src/sonos.ts` - minimal Sonos UPnP client over `client.net.fetch`
  (discovery, transport, volume, favorites, artwork).
- `src/index.css` - `@import "tailwindcss";` + theme tokens.
- `vite.config.ts` - vite + tailwind plugin, `es2022` target.
- `index.html` - 800x480 viewport, no overscroll, no tap highlight.
- `settings/` - the companion-side settings page (preact), built by
  `vite.settings.config.ts` into a single self-contained `dist/settings.html`.
  It reads and writes settings over `@bridgething/client/settings`.

`bun run build` runs both configs: the main app into `dist/`, then the settings
page as `dist/settings.html`. `manifest.json`'s `settings` field points the
companion at it.
