# live2d

A desktop **Live2D overlay**: a transparent, always-on-top window that renders a
Cubism 4 model driven in real time by your webcam (head pose, gaze, blinks,
mouth, brows via MediaPipe face tracking). It floats over games and the desktop,
can be locked to pass clicks through, and the model can be dragged and zoomed.

Built with **Electron + Vite + TypeScript + Pixi.js + pixi-live2d-display +
MediaPipe Tasks Vision**. Package manager: **pnpm**.

> Currently developed and tested on **macOS**. The system-overlay behavior
> (floating over fullscreen apps, appearing on every Space, never stealing
> focus) is implemented with raw AppKit calls; other platforms are not supported.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io/)
- A webcam (face tracking degrades gracefully — the app still runs if the
  camera is denied or unavailable)

## Getting started

```bash
pnpm install
pnpm dev
```

`pnpm dev` builds the Electron shell, starts the Vite dev server, waits for it,
and launches Electron pointed at it.

## Usage

- **Lock / unlock** (toggle click-through): **Cmd/Ctrl + Alt + L**, or use the
  menu-bar tray icon. Locked = clicks pass through to whatever is behind the
  overlay (hover still works); unlocked = the model and window are editable.
- **Move / resize the window**: when unlocked, a dashed frame appears with a
  drag bar at the top (move the whole window) and corner handles (resize it).
  Use these to reposition the overlay without grabbing the model by accident.
- **Move the model**: drag the model itself (when unlocked).
- **Zoom the model**: scroll over it (anchored under the cursor).
- **Expressions**: number keys **1–0** toggle the outfit/face expressions, or
  use the panel in the top-right.

Model position/zoom persist into the model's `[pos]` table; the window's own
position/size persist to `win.toml`. Both are gitignored (per-machine state).

## Scripts

```bash
pnpm dev          # build shell + Vite + launch Electron (scripts/dev.mjs)
pnpm build        # typecheck + vite build (dist/) + bundle main/preload (dist-electron/)
pnpm start        # run Electron against an existing build
pnpm dev:renderer # Vite only, in a plain browser (no Electron IPC, so no model loads)
```

## Configuration

Settings are TOML files loaded at runtime. In development they live under the
project's `config/web2d/` dir (in a packaged build, the per-user app-data dir):

- **`config.toml`** — model-independent feel/performance knobs (smoothing,
  head/eye/mouth gains, breath, wind, render/detect FPS, camera) plus `model`,
  the active model's name.
- **`models/<name>.toml`** — everything about one model: `location` (its asset
  dir) and `model` (its `.model3.json`), the on-screen `scale`, the `hair`/
  `clothes` parameter prefixes, the live `[pos]` transform, and the
  auto-discovered `[expressions.*]` (keybind + on/off state).

To add a model, drop it under `model/<name>/`, create `config/web2d/models/<name>.toml`
with its `location`/`model`/prefixes, and set `model = "<name>"` in `config.toml`.
Expressions are discovered automatically from the model's `*.exp3.json` files.
