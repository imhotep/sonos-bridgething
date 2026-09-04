# **PROJECT_NAME**

A bridgething webapp scaffolded with `create-bridgething`.

Stack: React 19 + Vite + Tailwind v4 + TypeScript strict, with
[`@bridgething/client`](https://github.com/JoeyEamigh/bridgething) preinstalled.

## Building with an agent

Open this folder with your coding agent (Claude Code, Codex, opencode, ...). It
reads `CLAUDE.md` / `AGENTS.md` and the `/bridgething` skill.

## Develop

```bash
bun install
bun run dev
```

Opens at http://localhost:5173/. The starter `App.tsx` connects to
`ws://<host>/` (the daemon's local WebSocket on port 8891 of the device
itself). To dev against a remote device, set:

```bash
VITE_BRIDGETHING_URL=ws://<device-ip>:8891/ bun run dev
```

## Push to a device

```bash
bun run push
```

`push` builds `dist/`, rsyncs it into `/var/bridgething/webapps/<manifest-id>/`
on the Car Thing, and switches the kiosk to your app. Pass an IP address to target
something other than `bridgething.local` over USB.

## Share

```bash
bun run build
bun run share
```

`share` writes `<name>-<version>.zip` from `dist/`. Anyone with a bridgething Car
Thing installs it from the app.

## Update the device

```bash
bun run update
```

`update` runs [`@bridgething/updater`](https://www.npmjs.com/package/@bridgething/updater)
to bring the connected Car Thing to the latest bridgething release. Multiple devices: `bun run update -- --host ws://bridgething-<serial>.local:8892/`.

## Layout

- `src/App.tsx` - starter UI: subscribes to `client.player.onSnapshot`,
  fetches artwork via `client.asset.get`, exposes transport controls.
- `src/index.css` - `@import "tailwindcss";`.
- `vite.config.ts` - vite + tailwind plugin, `es2022` target.
- `index.html` - 800x480 viewport, no overscroll, no tap highlight.
- `settings/` - the companion-side settings page (preact), built by
  `vite.settings.config.ts` into a single self-contained `dist/settings.html`.
  It reads and writes settings over `@bridgething/client/settings`.

`bun run build` runs both configs: the main app into `dist/`, then the settings
page as `dist/settings.html`. `manifest.json`'s `settings` field points the
companion at it.
