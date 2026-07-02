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
- [x] **Linux platform tuning (Wayland)** — native Wayland Ozone backend
      (`ozone-platform-hint=auto` + `ELECTRON_OZONE_PLATFORM_HINT=auto` in
      `dev.mjs`), `GlobalShortcutsPortal` feature flag, and
      `force-device-scale-factor=1` (this session's compositor reports scale 1.0 but
      Chromium derived a 1.046875 DPR, rendering a buffer ~4.7% wider than the window
      and clipping right/bottom-anchored UI — the expression panel fell off the right
      edge). Window **lock/click-through** is now enabled on Linux (§4.4); the renderer
      **move/resize guide** stays disabled there by design — the compositor's native
      window border handles move/resize (§4.3) — guarded on `linux` specifically so
      Windows keeps the guide.
      (`electron/main.ts`, `src/window-controls.ts`, `settings.html`)
- [x] **Linux global hotkeys via the XDG portal** — Electron's `globalShortcut`
      can never work on Hyprland: it doesn't declare an app id, so
      `xdg-desktop-portal-hyprland` rejects its GlobalShortcuts session. Replaced by
      the `global_hotkey/` napi (Rust/zbus) module: `Registry.Register("web2d")`
      (a minimal `.desktop` is written so the host registry accepts the id) →
      `CreateSession` → `BindShortcuts` → `Activated` signals delivered to a JS
      callback. Both `lock` and `recenter` are registered (§4.4). With
      `hyprlandAutoBind = true` in `config.toml`, the app binds the real keys itself via
      `overlay_hyprland.setKeyword("bind", …)` at startup and unbinds on quit; otherwise
      the user adds `bind = MODS, KEY, global, web2d:<id>` to `hyprland.conf`.
      (`global_hotkey/src/lib.rs`, `electron/main.ts`)
- [x] **Linux native resize + bounds restore** — the window is created `resizable` on
      Linux (the renderer guide can't drive a Wayland window). Geometry persists to
      `[window]` from `getClients()` (not `win.getBounds()`, untrustworthy on Wayland) —
      debounced on `resize` and synchronously on quit — and is restored on launch by
      dispatching `resizeWindowTo`/`moveWindowTo` once the window maps (§4.3).
      (`electron/main.ts`)

## Next up (ordered)

### 1. Land the dependency bump on master ✅ DONE

`master` is now the Electron 42 baseline (escapes the Node-26 install breakage),
fast-forwarded from `chore/bump-deps` and pushed. Includes the model-load CORS fix,
recenter hotkey + redesigned/utf-8 settings, colorized logging, and the perf wins.

### 2. Performance — config wins, then structural ✅ DONE

- **P0 (config only):** done — `[camera]` dropped to 720×405 and `detectFps` to 50 in
  the runtime `config.toml`. Biggest CPU/GPU reduction for no visible quality loss.
- **P2 (structural):** done — MediaPipe inference moved into a **Web Worker**
  (`src/face-worker.ts`, fed camera frames via a transferred `MediaStreamTrackProcessor`
  stream), so a slow `detectForVideo` can't stall the Pixi render loop; the worker
  throttles to `config.detectFps` and posts compact results back, smoothing runs per
  render frame on the main thread. (upstream commit `2aa5d15`)

### 3. Finish Settings window v1 (the real feature, not just hotkeys)  ← NEXT

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

## Linux overlay (Hyprland-first)

Goal: bring the Linux overlay to parity with macOS — floats over fullscreen apps,
never takes focus, movable/resizable when unlocked, click-through when locked.
Hyprland is the reference compositor; every Hyprland-specific path must detect
"not Hyprland" and no-op cleanly. The portal hotkey work (see Done) removed the
original blocker for all of this: there is now a reliable way back out of any
overlay state without focusing the window.

### 4.1 `overlay_hyprland` napi crate — compositor control ✅ DONE

A second Rust napi crate next to `global_hotkey/` (`overlay_hyprland/`), wrapping the
[hyprland](https://crates.io/crates/hyprland) crate — **0.4.0-beta.3, not the 0.3.13
stable**: 0.3.x hardcodes `/tmp/hypr` for the IPC socket, but modern Hyprland puts it
under `$XDG_RUNTIME_DIR/hypr`, so 0.3.13 can't connect at all. Verified against the
live compositor. The JS surface (`@web2d/overlay_hyprland`):

- `isHyprland()` — env check; every other export throws cleanly off-Hyprland.
- `getClients()` / `getMonitors()` — window (address/pid/class/title/rect) and
  monitor (origin/size/scale/focused) data for finding our window and clamping.
- `moveWindowBy/To`, `resizeWindowBy/To` — `movewindowpixel`/`resizewindowpixel`
  dispatches targeted by address; the `By` variants take deltas (no global cursor
  coords needed on Wayland).
- `setWindowRules(name, rules)` — `windowrule[<name>]:<prop> <value>` keywords.
- `setKeyword(key, value)` — generic `hyprctl keyword` equivalent, reply-checked
  (the hyprland crate's own `Keyword::set` discards errors), so
  `applyHyprlandBind`'s bind/unbind shell-outs can migrate onto it.

Wired into Electron: added to root `package.json` + `build:native`, esbuild
`external`, and used from `electron/main.ts` (windowrules 4.2, lock 4.4, bounds
restore). `applyHyprlandBind`'s bind/unbind now go through `setKeyword`.

### 4.2 Windowrules ✅ DONE

Applied via `overlay_hyprland.setWindowRules("web2d", …)` in `electron/main.ts`,
gated on `onHyprland()`. Split like `applyMacOverlay` — a BASE set always on at
startup, a LOCK set toggled by the lock (4.4):

```
# BASE — startLinuxOverlayRules(), always on
windowrule[web2d]:opacity 1.0 override 1.0 override 1.0 override
windowrule[web2d]:float true      # never toggled: a tiled overlay can't be moved
windowrule[web2d]:pin true        # never toggled: always across all workspaces

# LOCK — applyHyprlandLock(), flipped on lock/unlock (unlock sets explicit off
# values, not "unset"; border_size 0↔5 keeps it findable while movable)
windowrule[web2d]:no_focus        true / false
windowrule[web2d]:border_size     0 / 5
windowrule[web2d]:no_blur         true / false
windowrule[web2d]:no_dim          true / false
windowrule[web2d]:no_shadow       true / false
windowrule[web2d]:no_follow_mouse true / false
```

- `suppress_event` was dropped (not wanted). All rules `unset` on quit.
- OPEN: the `[web2d]` selector matches by app-id/class — dev may report `electron`,
  in which case these silently match nothing. `float`/`pin` sidestep this because
  they can move to the address-targeted `set_floating`/`set_pinned` dispatchers if
  the selector ever proves unreliable; the toggled set still relies on the selector.
  Verify with `hyprctl clients`.

### 4.3 Move/resize on Linux ✅ DONE

No renderer guide on Linux — superseded by the compositor's native window border. The
`border_size 5` unlock rule (4.2) gives Hyprland a grab edge to move/resize the window
directly; the guide's screenX/Y-delta `setBounds` math (which Wayland forbids for
position) isn't needed.

- Geometry restore/persist: on launch, dispatch `resizeWindowTo`/`moveWindowTo` to the
  saved bounds once the window appears in `getClients()` (Wayland ignores creation x/y).
  Persist by reading `getClients()` geometry — on `will-quit` (sync) and on the
  debounced `resize` listener — never `win.getBounds()` (untrustworthy on Wayland).

### 4.4 Click-through lock on Linux ✅ DONE

The lock system was disabled on Linux because click-through could strand the overlay
(no working global hotkey, tray needs an SNI host). The portal hotkey removed that
blocker, and the tray Lock item is a way out that doesn't need the hotkey bound:

- `startLinuxGlobalShortcuts` registers both `lock` and `recenter` portal shortcuts;
  `hyprlandAutoBind` binds both combos.
- Dropped the `IS_LINUX` guards in `setOverlayLock` / `config:set-hotkey` / the tray
  Lock item / the settings hotkey row; updated the stale top-of-file comment.
- OPEN: `{forward: true}` hover-forwarding is macOS/Windows-only, so hover reactions
  while locked are lost on Linux (acceptable for v1).

### 4.5 Polish ✅ DONE

- ✅ tray checkmark refresh — `setUiToggle` rebuilds the menu via `setContextMenu`
  (libdbusmenu doesn't live-update `checked`); checkbox clicks drive off own state,
  not `item.checked`.
- ✅ overlay findability when unlocked — the `border_size 5` unlock rule (4.2) draws a
  compositor border, so the renderer-drawn inner-border idea is unnecessary.

### 4.6 Beyond Hyprland (later)

- **Other Wayland compositors**: the pin/no-focus/over-fullscreen behavior above is
  all Hyprland keywords. Investigate DmNote's Linux overlay technique and/or a
  layer-shell surface for a compositor-agnostic path; the native Wayland backend
  already gets the overlay floating and on-screen.
- **Windows support**: the platform guards are scoped to `linux`, so the lock +
  move/resize systems remain available there; port the macOS overlay treatment
  (topmost level, no activation, over-fullscreen) to Win32.

## Notes

- A previous Linux click-through attempt (renderer streams the model bbox, main
  polls the global cursor) was removed as non-working — see git history before
  reattempting. Click-through is currently disabled by design on Linux (Done →
  Linux platform tuning); re-enabling it is planned as 4.4.
- The repo path (`rust/live2d`) and `README.md` are stale Tauri-era artifacts; the
  app is all TS/Electron now.
- Transparent always-on-top-but-click-below reference:
  <https://stackoverflow.com/questions/50142924/create-electron-transparent-window-ontop-but-clickable-below-programs>
