# web2d — roadmap

A Live2D desktop overlay (Electron + Vite + TS + Pixi + MediaPipe). Status as of
this revision; checked items are in the tree today.

## Done

- [x] **Overlay window (macOS)** — AppKit `NSWindow` treatment via koffi FFI:
      status level, joins all Spaces, floats over fullscreen, never steals focus.
      (`electron/mac-overlay.ts`)
- [x] **Click-through toggle** — global hotkey **Cmd/Ctrl+Alt+L** + tray menu.
      (`electron/main.ts`)
- [x] **Move/resize guide** — when unlocked, a drag bar + corner handles move and
      resize the OS window without grabbing the model. (`src/window-controls.ts`)
- [x] **Rebrand to "web2d"** — `app.setName` + `setAppUserModelId` + `process.title`
      (`electron/main.ts`), window/document title, `name`/`productName`
      (`package.json`), tray label. Activity Monitor still shows "Electron" in dev
      until the app is packaged with a renamed binary.
- [x] **Runtime TOML config (0.1 + 0.15)** — `electron/config.ts` loads
      `config.toml` + `models/<name>.toml` (selected by `config.toml`'s `model`
      field) and hands it to the renderer via `config:get`. The model file holds
      `location`/`model` (required), a `[gain]` table generated from the model's
      `physics3.json` (one entry per physics setting name, `v` = swing multiplier),
      the live
      `[pos]`, and auto-discovered `[expressions.*]`. First load centers the model
      at scale 1; `[pos]` persists drag/zoom. `src/config.ts` is now just types +
      blank defaults. Replaced `model-config.ts`, `generated.ts`,
      `build-exp-keys.mjs`, root `pos.toml`. Config dir is gitignored
      `config/web2d/`; a future step swaps it for the per-platform dir.

## Backlog

### 0.2

stablize the macos overlay, first the window has to be click through when it needs to be, second it has to be top most, third it has to avoid beening captured by the aerospace WM on mac. For reference dm-note <https://github.com/DmNote-App/DmNote> acheaved a perfected overylay windows effect.

### 1. Settings window

A separate window that configures and controls the overlay window (model picker,
the `config.toml` knobs, lock state). Builds on 0.1 as its data layer.

### 2. Click-through on Linux/Wayland

The toggle works on macOS; make Cmd+Alt+L + click-through behave on Linux/Wayland.
<https://www.electronjs.org/docs/latest/api/global-shortcut>

### 3. Drag/resize bar when not click-through

- [x] Done (item under "Done" above). Kept here for numbering continuity.

### 4. DmNote's Linux overlay technique

Find out how DmNote achieves the always-on-top / all-workspaces / float-over-
fullscreen overlay on Linux (the macOS path is already mirrored).

### 4.5 Windows support

Bring the overlay behavior to Windows.

## Notes

- A previous Linux click-through attempt (renderer streams the model bbox, main
  polls the global cursor) was removed as non-working — see git history before
  reattempting under #2/#4.
- Transparent always-on-top-but-click-below reference:
  <https://stackoverflow.com/questions/50142924/create-electron-transparent-window-ontop-but-clickable-below-programs>
