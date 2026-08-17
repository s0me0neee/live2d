# web2d

A desktop **Live2D overlay**: a transparent, always-on-top window that renders a
Cubism 4 model driven in real time by your webcam (head pose, gaze, blinks,
mouth, brows via MediaPipe face tracking). On Hyprland it also watches your mouse
cursor whenever no face is being tracked. The window floats over games and the
desktop, can be locked to pass clicks through, and the model can be dragged and
zoomed.

Built with **Electron + Vite + TypeScript + Pixi.js + pixi-live2d-display +
MediaPipe Tasks Vision**, plus two small Rust (napi-rs) modules for the Linux
compositor integration. Package manager: **pnpm**.

## Platform support

| | macOS | Linux (Hyprland) | Windows |
| --- | --- | --- | --- |
| Overlay treatment | AppKit `NSWindow` via FFI | Hyprland `windowrule` keywords | plain Electron |
| Click-through lock | ✅ (hover preserved) | ✅ (no hover while locked) | untested |
| Global hotkeys | Electron `globalShortcut` | XDG GlobalShortcuts portal | untested |
| Move / resize window | in-app guide | compositor window border | in-app guide |
| Cursor look-at | — (Hyprland-only) | ✅ incl. while click-through | — (Hyprland-only) |

macOS and Linux/Hyprland are the two supported targets. Other Wayland
compositors get the generic Electron behavior (the Hyprland-specific paths detect
"not Hyprland" and no-op); Windows has no platform-specific code but isn't tested.

## Requirements

- Node.js 20+ and [pnpm](https://pnpm.io/)
- **Linux only:** a Rust toolchain (for `pnpm build:native`),
  `xdg-desktop-portal-hyprland` for global hotkeys, and a Hyprland session for
  the overlay window rules
- A webcam — optional. Face tracking degrades gracefully: if the camera is
  denied or missing, the model still runs and follows the cursor instead
- A Cubism 4 model (`*.model3.json` + its asset dir) somewhere on disk

## Getting started

```bash
pnpm install
pnpm build:native   # Linux only — builds global_hotkey/ and overlay_hyprland/
pnpm dev
```

`pnpm dev` builds the Electron shell, starts the Vite dev server, waits for it,
and launches Electron pointed at it.

Then point it at a model — see [Configuration](#configuration). Until
`models/<name>.toml` has a valid `location`/`model`, the window comes up empty.

### Hyprland hotkeys

The portal registers shortcut **ids**, not key combos, so the compositor decides
the actual keys. Either let the app bind them for you:

```toml
# config/web2d/config.toml
hyprlandAutoBind = true
```

…or bind them yourself in `hyprland.conf`:

```
bind = CTRL ALT, L, global, web2d:lock
bind = CTRL ALT, R, global, web2d:recenter
```

## Usage

- **Lock / unlock** (toggle click-through): **Cmd/Ctrl + Alt + L** by default, or
  the tray menu. Locked = clicks pass through to whatever is behind the overlay;
  unlocked = the model and window are editable. On Linux the window also gains a
  compositor border while unlocked.
- **Move / resize the window**: unlocked, macOS/Windows show a dashed frame with a
  drag bar (move) and corner handles (resize). On Linux use the compositor's own
  window border instead.
- **Move the model**: drag it (when unlocked). **Zoom**: scroll over it, anchored
  under the cursor.
- **Expressions**: number keys **1–0** toggle outfit/face expressions, or use the
  panel in the top-right. Several can be on at once.
- **Recenter face tracking** (**Cmd/Ctrl + Alt + R** by default, or the tray):
  re-captures your neutral head pose and gaze baseline, so the model faces
  forward at whatever pose you're actually sitting in.
- **Tray menu**: lock, recenter, reload config, show/hide the FPS counter and
  expression list, **Settings…** (rebind the hotkeys), **Face tracking debug…**
  (live landmark mesh + gaze/mouth readout, for tuning), quit.

Window geometry and the model's position/zoom persist automatically to
`config/web2d/local.toml`.

## Configuration

Settings are TOML files loaded at runtime, seeded on first run. In development
they live under the project's `config/web2d/`; in a packaged build, the per-user
app-data dir.

**`config.toml`** — model-independent knobs plus `model`, the active model's name:

| key | what it does |
| --- | --- |
| `model` | active model = `models/<model>.toml` |
| `mirror`, `smoothing` | mirror the tracking; per-frame smoothing toward the target |
| `headGain`, `headClampDeg`, `bodyFollow`, `breath` | head/body/breath feel |
| `[physics]` | pendulum sim: `springiness`, wind (`windEnabled`, `wind`, `gust`, `gustHz`) |
| `[eyes]`, `[jaw]` | blink and mouth-open shaping (`deadzone`/`curve`/`gain`, `gazeGain`, `openMax`) |
| `renderFps`, `detectFps`, `[camera]` | render cap, detection rate, capture resolution |
| `[cursorLook]` | cursor follow (Hyprland): `enabled`, `range`, `headDeg`, `eyeGain`, `lagMs` |
| `lockHotkey`, `recenterHotkey` | Electron accelerators; `""` = unbound |
| `hyprlandAutoBind` | Linux: bind the portal shortcuts via `hyprctl` at startup |
| `showFps`, `showExpressions` | overlay UI visibility (also in the tray) |

**`models/<name>.toml`** — everything about one model:

- `location` — the model's asset dir (absolute, or relative to the project root)
- `model` — the `.model3.json` filename inside it
- `[gain]` — one multiplier per physics setting (from the model's
  `physics3.json`), `1` = unchanged; raise one to exaggerate that group's swing
  (hair, tail, skirt…)
- `[expressions.*]` — discovered from the model's `*.exp3.json` files, each with a
  `key` (1–0) and `active` state

Because `location` is usually an absolute path, a model used from more than one
machine gets one profile per machine (e.g. `zero.toml` and `zero-linux.toml`).

**`local.toml`** — per-machine volatile state (window geometry, live model
transform). Gitignored; nothing in it is meant to be edited by hand.

To add a model: create `config/web2d/models/<name>.toml` with `location` and
`model`, set `model = "<name>"` in `config.toml`, and restart (or use the tray's
"Reload config"). Gain entries and expressions are filled in automatically on
load.

## Scripts

```bash
pnpm dev           # build shell + Vite + launch Electron (scripts/dev.mjs)
pnpm dev:perf      # same, with NODE_ENV=production + GPU flags
pnpm build         # native + typecheck + vite build (dist/) + main/preload (dist-electron/)
pnpm build:native  # the two Rust napi modules (Linux)
pnpm start         # run Electron against an existing build
pnpm dev:renderer  # Vite only, in a plain browser (no Electron IPC, so no model loads)
pnpm release       # production build, then package (scripts/release.mjs)
```

`pnpm exec tsc` typechecks without building — there's no linter and no test suite.

> Packaging (`pnpm release`) is unverified: the script assumes electron-builder,
> which isn't installed or configured yet. See the caveat comment in
> `scripts/release.mjs`.
