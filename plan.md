# web2d — roadmap

A Live2D desktop overlay (Electron + Vite + TS + Pixi + MediaPipe). Status as of
this revision; checked items are in the tree today.

## Done

- [x] **Overlay window (macOS)** — AppKit `NSWindow` treatment via koffi FFI:
      status level, joins all Spaces, floats over fullscreen, never steals focus.
      (`electron/mac-overlay.ts`)
- [x] **Click-through toggle** — global hotkey + tray menu. (`electron/main.ts`)
- [x] **Move/resize guide** — when unlocked, a drag bar + corner handles move and
      resize the OS window without grabbing the model. (`src/window-controls.ts`)
- [x] **Stabilize the macOS overlay (0.2)** — top-most, click-through when needed,
      no longer captured by the AeroSpace WM. Two causes fixed: `app.setName()`
      flipped the activation policy to "regular" (dropped it; keep
      `setActivationPolicy("accessory")` before `whenReady`), and the frameless
      window kept its AX close button (set `closable:false` at creation so
      AeroSpace's `isWindowHeuristic` leaves it alone). (`electron/main.ts`)
- [x] **Runtime TOML config (0.1 + 0.15)** — `electron/config.ts` loads
      `config.toml` + `models/<name>.toml` and hands it to the renderer via
      `config:get`. Model file holds `location`/`model`, a `[gain]` table generated
      from `physics3.json`, live `[pos]`, and auto-discovered `[expressions.*]`.
      `src/config.ts` is types + blank defaults.
- [x] **Models outside the project dir** — `web2dmodel://` custom protocol serves a
      model's whole asset tree from an arbitrary on-disk location, gated to resolved
      model roots. (`electron/model-protocol.ts`)
- [x] **Physics-aware head/body + eyes** — head pose written to the physics INPUT
      when the model derives angles as secondary motion; body-follow skips
      physics-driven params; `[eyes]` shaping (deadzone/curve/gain/gaze).
      (`src/face-tracking.ts`)
- [x] **Settings window — plumbing** — single-instance framed/focusable window,
      opened from the tray "Settings…", 2nd Vite entry (`settings.html` →
      `src/settings/main.ts`), shares `preload.cjs`. Modern grouped-card UI.
      (`electron/settings-window.ts`)
- [x] **Configurable global hotkeys** — lock + recenter, rebindable from the
      settings window and unbindable to empty; persisted in `config.toml`.
- [x] **Tray controls** — Lock, Recenter, Reload config (reloads the renderer),
      Show FPS counter, Show expression list, Settings…, Quit.
- [x] **Colorized stdout logging** — `electron/log.ts` (picocolors), per-module
      tags + levels; renderer console forwarded and colorized. (`forward-console.ts`)
- [x] **Dependency bump** — Electron 33→42 (escapes the Node-26 install breakage),
      esbuild 0.28, Vite 8, pixi pinned v7; CORS fix for the model scheme under
      Electron 42. *(on branch `chore/bump-deps`; not yet merged — see Next up #1)*
- [x] **Perf — quick wins** — render FPS cap, reused blendshape object (no per-frame
      alloc), MediaPipe code-split out of the entry bundle.

## Next up (ordered)

### 1. Land the dependency bump on master ✅ DONE
`master` is now the Electron 42 baseline (escapes the Node-26 install breakage),
fast-forwarded from `chore/bump-deps` and pushed. Includes the model-load CORS fix,
recenter hotkey + redesigned/utf-8 settings, colorized logging, and the perf wins.

### 2. Performance — config wins, then structural  ← NEXT
- **P0 (config only):** drop `[camera]` to ~640×480 and `detectFps` to 30. Biggest
  CPU/GPU reduction for no visible quality loss; may make P2 unnecessary.
- **P2 (structural):** move MediaPipe inference into a **Web Worker**
  (`ImageBitmap`/`OffscreenCanvas`) so a slow detect frame can't stall the Pixi
  render loop. Only pursue if P0 isn't enough under game load.

### 3. Finish Settings window v1 (the real feature, not just hotkeys)
The window today configures **only hotkeys**. The original v1 scope — active-model
picker, lock toggle, recenter button, `[gain]` sliders, expression toggles — is still
unbuilt, and changes apply via the interim tray **"Reload config"** (full renderer
reload) rather than live re-apply.

**a. Config / IPC surface** (`electron/config.ts`, `main.ts`, `preload.ts`)
- `listModels()` (basenames of `models/*.toml`), `setActiveModel(name)`,
  `setGain(name, value)` (patch `[gain].<name>` multiplier only), reuse
  `setExpressionActive`. Expose `listModels`/`setModel`/`setGain`/`onConfigChanged`.
- After a scalar write, `loadConfig()` and broadcast `config:changed`
  (`ResolvedConfig`) to the overlay window. `setActiveModel` reloads the overlay
  renderer instead (a live model dispose/reload is too fragile for v1).

**b. Overlay live-apply** (`src/main.ts` + feature modules)
- Have `physics.ts` / `face-tracking.ts` / `expressions/` return a handle with an
  `apply(config, modelConfig)` step (recompute `gainGroups` on `[gain]` change,
  `setActive(name, active)` for expressions). `src/main.ts` keeps mutable
  `config`/`modelConfig`, subscribes to `onConfigChanged`, fans values out.
- This retires the tray "Reload config" workaround for scalar edits.

**c. Settings UI** (`src/settings/main.ts`, `settings.html`)
- Plain-DOM TS. Add sections under the existing hotkeys: model dropdown, lock toggle
  (`getLock`/`onLockChanged`/`setLock`), recenter button, a gain slider per
  `model.gain` entry (≈0–3, step 0.05), expression checkboxes (show assigned key).
- RISK: an accessory (LSUIElement) app can be flaky taking **keyboard** focus.
  Keep v1 controls mouse-only (dropdown/toggle/slider/checkbox); revisit focus
  rather than the activation policy if typed input is ever needed.

**Phasing:** (1) read-only render of model/lock/gain/expressions from `getConfig()` →
(2) writes + `config:changed` + overlay apply handles → (3) model picker → reload.

## Backlog (later platforms)

### 4. Click-through on Linux/Wayland
The toggle works on macOS; make the hotkey + click-through behave on Linux/Wayland.
<https://www.electronjs.org/docs/latest/api/global-shortcut>

### 5. DmNote's Linux overlay technique
How DmNote achieves always-on-top / all-workspaces / float-over-fullscreen on Linux
(the macOS path is already mirrored).

### 6. Windows support
Bring the overlay behavior to Windows.

## Notes

- A previous Linux click-through attempt (renderer streams the model bbox, main
  polls the global cursor) was removed as non-working — see git history before
  reattempting under #4/#5.
- The repo path (`rust/live2d`) and `README.md` are stale Tauri-era artifacts; the
  app is all TS/Electron now.
- Transparent always-on-top-but-click-below reference:
  <https://stackoverflow.com/questions/50142924/create-electron-transparent-window-ontop-but-clickable-below-programs>
