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
- [x] **Rebrand to "web2d"** — `setAppUserModelId` + `process.title`
      (`electron/main.ts`), window/document title, `name`/`productName`
      (`package.json`), tray label. `app.setName()` is intentionally NOT called: it
      resets the activation policy back to "regular", which makes AeroSpace capture
      the overlay (see 0.2). Activity Monitor still shows "Electron" in dev until the
      app is packaged with a renamed binary.
- [x] **Stabilize the macOS overlay (0.2)** — click-through when needed, always
      top-most, and no longer captured by the AeroSpace WM. The capture was caused
      by `app.setName()` flipping the activation policy to "regular"; dropping it
      (keeping `setActivationPolicy("accessory")` before `whenReady`) keeps the
      window an accessory so AeroSpace leaves it alone. (`electron/main.ts`)
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

### 1. Settings window

A second, normal (framed, focusable, opaque, NOT always-on-top, NOT overlay-styled)
window that configures and controls the overlay. Opened from the tray. Builds on the
0.1 TOML config as its data layer.

**v1 scope (core controls):** active-model picker, lock / click-through toggle,
"recenter face tracking" button, the model's `[gain]` sliders, and expression
toggles. Defers the full `config.toml` Config table (smoothing/fps/camera/physics…)
to a later pass.

**Apply model:** scalar edits **live re-apply** to the overlay with no reload — main
writes the TOML and broadcasts `config:changed`; the overlay re-runs each feature
module's apply step. The one exception is **switching the active model**, which
reloads the overlay renderer (a live model dispose/reload is too fragile to be worth
it in v1).

**a. Window + process wiring** (`electron/`)
- New `electron/settings-window.ts`: a single-instance `BrowserWindow` (framed,
  `focusable:true`, opaque, normal level, `skipTaskbar:false`). Same `preload.cjs`
  so it gets `window.electronAPI`. If already open, focus instead of recreating.
  Do **NOT** call `applyMacOverlay` on it.
- Open it from a new tray item "Settings…" (and reuse for a possible later hotkey).
  Keep `app.setActivationPolicy("accessory")` — do not flip to "regular" (that's the
  0.2 AeroSpace regression). Accessory apps can still focus a window; on open call
  `win.show()` + `win.focus()` (and `app.focus({steal:true})` if needs be).
- RISK: an accessory (LSUIElement) app can be flaky at taking **keyboard** focus for
  text fields. v1 controls are all dropdown / toggle / slider / button / checkbox
  (no free-text), which work with mouse focus alone — keep it that way; if a future
  knob needs typed input, revisit focus handling rather than changing the policy.

**b. Build wiring** (`vite.config.ts`, project root)
- Add a second Vite entry: `build.rollupOptions.input = { main: "index.html",
  settings: "settings.html" }`. New root `settings.html` loads `src/settings/main.ts`.
- Main loads it via `loadFile(dist/settings.html)` packaged, or
  `${ELECTRON_RENDERER_URL}/settings.html` in dev. `base:"./"` already set.

**c. Config / IPC surface** (`electron/config.ts`, `electron/main.ts`, `preload.ts`)
- `electron/config.ts`: add `listModels()` (basenames of `models/*.toml`),
  `setActiveModel(name)` (patch `config.toml.model`), `setGain(name, value)` (patch
  model TOML `[gain].<name>` — only the multiplier; params stay physics-derived on
  load), and reuse `setExpressionActive`. Optional `setExpressionKey(name, key)`.
- `electron/main.ts`: handlers `settings:open`, `config:list-models`,
  `config:set-model`, `config:set-gain`; a `face:recenter` handler that forwards to
  the overlay (so the button and the existing tray item share one path). After any
  scalar write, `loadConfig()` and send `config:changed` (fresh `ResolvedConfig`) to
  the **overlay** window. `config:set-model` instead reloads the overlay renderer.
  Lock reuses the existing `overlay:*` IPC.
- `preload.ts` + `src/global.d.ts`: expose `openSettings()`, `listModels()`,
  `setModel(name)`, `setGain(name, value)`, `recenter()`, and `onConfigChanged(cb)`.

**d. Overlay live-apply** (`src/main.ts` + feature modules)
- Make the feature setups return a handle with an apply step instead of baking config
  into closures only at boot:
  - `physics.ts`: wrap the field mutation in an `apply(config)` called at setup and on
    change.
  - `face-tracking.ts`: hold `config`/`modelConfig` in a mutable ref; recompute
    `gainGroups` when `[gain]` changes; expose `update(config, modelConfig)`.
  - `expressions/`: expose `setActive(name, active)` so a toggle made in settings is
    applied to the model (the settings checkbox is the source; the model lives in the
    overlay).
  - Lock already flows through `overlay:lock-changed`; nothing to add.
- `src/main.ts`: keep mutable `config`/`modelConfig`, subscribe to `onConfigChanged`,
  and fan the new values out to the handles above.

**e. Settings UI** (`src/settings/main.ts`, `settings.html`, small CSS)
- Plain-DOM TS (matches `window-controls.ts` / `expressions/` style; no framework).
  Populate from `getConfig()` + `listModels()`; sections: model dropdown, lock toggle
  (`getLock`/`onLockChanged`/`setLock`), recenter button, a gain slider per
  `model.gain` entry (≈0–3, step 0.05), expression checkboxes (show assigned key).

**Phasing**
1. Window + tray "Settings…" + Vite 2nd entry + blank page that loads (proves the
   two-window / two-entry plumbing under the accessory policy).
2. Read-only render of model / lock / gain / expressions from `getConfig()`.
3. Writes + `config:changed` broadcast + overlay apply handles (lock, recenter, gain,
   expression toggles).
4. Model picker → overlay reload on switch.

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
