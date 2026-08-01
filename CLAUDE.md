# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comments

Write as few comments as possible. Prefer self-documenting code: clear names
and small, well-named functions over explanation. Default to zero comments and
only add one when the code genuinely cannot speak for itself.

Only comment to explain WHY, never WHAT:

- The reason for a non-obvious approach over the obvious one.
- Invariants or constraints the code depends on but doesn't show.
- Workarounds — state the cause and link the issue if one exists.
- Surprising-but-intentional behavior that looks like a bug.

Never write:

- Comments that restate the code (`i += 1; // increment i`).
- Section banners, decorative dividers, or narration of obvious steps.
- TODO/commented-out code unless explicitly asked.

If a comment can be eliminated by renaming a variable or extracting a function,
do that instead of commenting.

Doc comments (e.g. Rust `///`) on public APIs are the exception: keep them where
they describe contract/usage for consumers, even when the implementation is obvious.

A comment is a maintenance liability that can rot out of sync with the code, so
each one must earn its place. If unsure, leave it out.

## What this is

A desktop **Live2D overlay**: a transparent, always-on-top, click-through window that renders a Cubism 4 model driven in real time by webcam face tracking — and, when no face is being tracked, by the mouse cursor. The window floats over games/the desktop and can be locked (click-through) or unlocked (movable, model draggable/zoomable).

Stack: **Electron + Vite + TypeScript + Pixi.js v7 + pixi-live2d-display-lipsyncpatch + MediaPipe Tasks Vision**, plus two **Rust napi-rs** modules used only on Linux. Package manager is **pnpm**.

Two platforms are implemented: **macOS** (AppKit FFI overlay treatment) and **Linux/Hyprland** (compositor keywords + XDG portal global shortcuts). Guards are written against `darwin`/`linux` specifically, except where the workaround is actually a **Wayland** problem rather than a Linux one (no self-positioning windows, no global cursor query, no native global-shortcut grab) — those check `IS_WAYLAND`/`isWayland` (`electron/platform.ts`, env-detected via `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`) instead, so X11 Linux gets the same plain-Electron subset as Windows and macOS. Windows itself gets that subset (lock, renderer move/resize guide) too — untested.

> Note: the repo path (`rust/live2d`) is a stale Tauri-era artifact — this was originally a Tauri/Rust app, rewritten to Electron. Comments throughout reference the original Tauri/DmNote behavior they aim to match; ignore the Tauri framing, the only Rust left is the two napi modules. `plan.md` is a roadmap whose "Notes" section is out of date (it still claims Linux click-through is disabled; it isn't).

## Commands

```bash
pnpm dev          # build the Electron shell, start Vite, launch Electron (scripts/dev.mjs)
pnpm dev:perf     # same, NODE_ENV=production + Metal/GPU flags (macOS)
pnpm build        # build:native + install + tsc + vite build (-> dist/) + esbuild (-> dist-electron/)
pnpm build:native # the two Rust napi crates (Linux-only; needs a Rust toolchain)
pnpm build:renderer / pnpm build:electron   # the two JS halves on their own
pnpm start        # run Electron against an existing build
pnpm dev:renderer # Vite only, plain browser (no electronAPI → no config/IPC, so no model loads)
pnpm release      # scripts/release.mjs — prod build, then electron-builder (see caveat in the file)
```

`pnpm build` starts with `build:native`, which only makes sense on Linux (the crates talk to Hyprland IPC and the XDG portal over D-Bus); on macOS use `build:renderer` + `build:electron`.

There is **no linter and no real test suite** — `pnpm test` exists but `test/test.ts` is a one-line commented-out stub. `tsc` is the only static check: TS is strict with `noUnusedLocals`/`noUnusedParameters`. Typecheck without building: `pnpm exec tsc`. `tsconfig.json` includes `src`, `test`, `global_hotkey` — **not `electron/`**, whose sources are type-erased by esbuild, so verify main-process changes carefully. For Rust changes, `cargo check` in the crate dir.

## Architecture

Three toolchains:

- **Main + preload** (`electron/`, TypeScript) → bundled to **CommonJS** `dist-electron/{main,preload}.cjs` by **esbuild** (`scripts/build-electron.mjs`). `electron`, `koffi` and both napi modules are kept external (native/can't bundle). `.cjs` is deliberate so they stay CommonJS despite `"type": "module"`.
- **Renderer** (`src/`) → built by **Vite** to `dist/`, three HTML entries: `index.html` (the overlay), `settings.html`, `face-debug.html`. Vite `base: "./"` so it loads over `file://` when packaged. Dev server is fixed at port **1420** (`vite.config.ts`); `dev.mjs` passes the URL to Electron via `ELECTRON_RENDERER_URL`, and each window picks dev-URL vs `loadFile` off that env var.
- **Native** (`global_hotkey/`, `overlay_hyprland/`) → **napi-rs** (`napi build --platform --release`), linked into the root `package.json` as `@web2d/global-hotkey` / `@web2d/overlay_hyprland`. The built `.node` files are **gitignored**, so a fresh clone must run `pnpm build:native`; both are `require`d lazily inside try/catch, so a missing module logs a warning and disables that feature rather than failing boot. `Cargo.lock` is committed.

The renderer talks to main only through `electron/preload.ts`, which `contextBridge`-exposes `window.electronAPI` (typed in `src/global.d.ts`). Outside Electron (`pnpm dev:renderer`) `electronAPI` is absent and dependent features feature-detect and no-op.

### Overlay window behavior — the core trick

The hard part of this project is making a borderless, transparent window behave like a true system overlay (float over fullscreen apps, appear on every workspace, never steal focus, optionally pass clicks through). Each platform needs a different escape hatch out of Electron's window API:

- **macOS** (`electron/mac-overlay.ts`): reaches into the live `NSWindow` via **raw AppKit FFI** (`koffi` → `objc_msgSend`): `NSStatusWindowLevel`, `canJoinAllSpaces | fullScreenAuxiliary`, `setHidesOnDeactivate:NO`, `orderFrontRegardless`. AppKit resets these on reorder, so `applyMacOverlay()` re-runs on `show`/`blur`/`ready-to-show`. `app.setActivationPolicy("accessory")` **must** run at module load (before `whenReady`) or AX window managers (AeroSpace) latch onto the window; `closable:false` at creation drops the AX close button for the same reason, and `app.setName()` must not be called (it flips the policy back to "regular").
- **Linux/Hyprland** (`electron/main.ts` + `overlay_hyprland/`): the analogue is dynamic `windowrule[web2d]:<prop> <value>` keywords over the Hyprland IPC socket, gated on `onHyprland()` (an `isHyprland()` runtime check, not just being on Linux/Wayland — there's no generic-Wayland implementation of this). Split like the mac path: `HYPRLAND_BASE_RULES` (opacity/float/pin) applied once at startup, `HYPRLAND_{LOCK,UNLOCK}_RULES` (no_focus, border_size 0↔5, no_blur/dim/shadow, no_follow_mouse) toggled with the lock. Unlock sets explicit off-values rather than `unset`, and `border_size 5` gives the compositor a grab edge — which is why there's no renderer move/resize guide on **Wayland** (X11 Linux keeps it). Also needs `ozone-platform-hint=auto` (XWayland reports a wrong devicePixelRatio) and `force-device-scale-factor=1`, both before `whenReady`, both Wayland-gated.
- **Click-through lock**: one boolean `overlayLocked`, toggled from the tray menu, a global hotkey, or renderer IPC (`overlay:toggle-lock` etc.). Locked = `setIgnoreMouseEvents(true, {forward:true})`. `forward:true` (hover while click-through) is macOS/Windows-only — on Linux (X11 or Wayland) the locked window gets no pointer events at all, which is what `cursor-look` works around. A working way back out of click-through is essential: the renderer can't receive a click to unlock itself.
- **Global hotkeys**: `lock` and `recenter`, both rebindable and unbindable (`""`). macOS and X11 Linux use Electron `globalShortcut` directly. Wayland **can't** — Electron never declares an app id, so the XDG GlobalShortcuts portal rejects its session; instead `global_hotkey/` (Rust/zbus) does `Registry.Register("web2d")` → `CreateSession` → `BindShortcuts` and delivers `Activated` back to JS, with a minimal `~/.local/share/applications/web2d.desktop` written (and rewritten when `process.execPath` goes stale) so the portal accepts the id. The portal binds *ids*, not keys: the user adds `bind = MODS, KEY, global, web2d:<lock|recenter>` to `hyprland.conf`, or sets `hyprlandAutoBind = true` (Hyprland-only, gated on `onHyprland()`) and the app drives `setKeyword("bind", …)` itself (unbinding before binding, since Hyprland stacks duplicates, and on quit).
- **Window geometry on Wayland**: Wayland clients can't self-position, so the saved bounds are restored by dispatching `resizeWindowTo`/`moveWindowTo` once the window appears in `getClients()` (retried, since it maps a moment after `showInactive()`), and persisted by *reading* `getClients()` — never `win.getBounds()`, which isn't trustworthy on Wayland. Both of those calls are Hyprland IPC, so they're a no-op on non-Hyprland Wayland; X11 Linux never needs this path, same as macOS/Windows.

Do not reintroduce the old Linux click-through approach (renderer streams the model's bounding box; main polls the global cursor against it to hit-test) — it was removed as non-working. The current cursor polling is only for look-at, never for hit-testing.

### Renderer composition (`src/main.ts`)

`main.ts` boots a Pixi `Application` on the `#live2d` canvas (transparent, capped at `config.renderFps` on both the app ticker and `Ticker.shared`), loads the model, bumps the Cubism clip-mask buffer count to 2, disables the runtime's built-in `automator.autoFocus`, then wires independent feature modules. Anything that can fail on a given machine is `.catch()`-guarded so the app survives camera denial / missing assets:

- `rig.ts` — **owns all parameter writing**. Holds the `Rig` type, two target slots (`pose` from face tracking, `look` from the cursor), picks whichever source is live, applies `headClampDeg` + `smoothing`, writes face params on `afterMotionUpdate` (so hair/cloth physics reacts to them) and body-follow + `[gain]` swing on `beforeModelUpdate` (after physics, which would otherwise clobber them). Face tracking wins while its results keep arriving (`FACE_STALE_MS`); the worker posts nothing when MediaPipe finds no face, so staleness covers denied camera, dead worker and face-out-of-frame alike. It hands the runtime's idle auto-blink back while no face drives the eyelids. Reaches into Cubism internals (`internalModel.coreModel`, `setParameterValueById`).
- `face-tracking.ts` — webcam → MediaPipe FaceLandmarker → `driver.pose`. Inference runs in a Web Worker (`face-worker.ts`, fed camera frames via a transferred `MediaStreamTrackProcessor` stream) so `detectForVideo` never stalls the render thread; the worker throttles to `config.detectFps` and posts compact results back. Head pose comes from the 4×4 transform matrix relative to a captured neutral (re-captured by the tray/hotkey "recenter"); gaze and mouth-open come from **landmark geometry**, not blendshapes (`face-geometry.ts`, shared with the debug viewer so the two can't drift) because `jawOpen`/`eyeLook*` misread under head pitch. Emits **unclamped** values — clamping is the rig's job.
- `cursor-look.ts` — head/gaze from the cursor, used only while the rig has no fresh face. Two input sources feeding one mapping: ordinary pointer events while clickable, and main's polled global cursor while click-through (`cursor:pos`, window-local). Distance is measured in model heights so zoom doesn't change the feel; filtering runs on the ticker (not per event) because both sources go silent when the mouse stops. `cursor:supported` just reflects the config toggle — main's poll works on every platform (Hyprland's own cursor query on Hyprland, Electron's `screen.getCursorScreenPoint()` everywhere else, since Wayland hides the global cursor from that API off Hyprland's own protocol).
- `physics.ts` — tunes the model's built-in pendulum physics + breath by mutating private Cubism fields (`internal.physics._physicsRig`, `breath._breathParameters`), driven by `config.physics`.
- `interaction.ts` — drag (grabs the model, not the canvas) + scroll-to-zoom (anchored under cursor); restores from / persists `{x,y,scale}` to `local.toml`'s `[pos.<model>]`.
- `expressions/` — independent outfit/face toggles (checkbox panel + number-key shortcuts), applied imperatively; each `.exp3.json` is fetched independently so one bad file drops only itself.
- `window-controls.ts` — the move/resize guide, shown only when **unlocked** and **not on Wayland**. Snapshots `windowControls.getBounds()` on grab, then translates the pointer's **global** `screenX/screenY` delta into new bounds via `windowControls.setBounds` (coalesced per rAF). `stopPropagation` so grabbing the guide doesn't also drag the model. Main persists bounds to `local.toml`'s `[window]` (debounced).
- `settings/` (`settings.html`) — hotkey capture/rebind UI. Hotkeys only so far; the model picker / gain sliders in `plan.md` are unbuilt, and config edits currently need the tray's "Reload config" (a renderer reload).
- `face-debug/` (`face-debug.html`) — live landmark mesh + gaze/mouth readout, fed by the overlay relaying each `FaceResult` through main. Used to live-tune `jaw`/`eyes` values.
- `fps.ts`, `pos-store.ts`, `model-url.ts`.

### Configuration (runtime TOML)

Config is loaded at runtime from TOML by the **main process** (`electron/config.ts`) and handed to the renderer via the `config:get` IPC at boot. `src/config.ts` holds only the shared TS **types + default values** (used to seed files and back-fill missing keys) — it is *not* the live config. `smol-toml` does the parse/stringify.

- **Config dir**: dev (`!app.isPackaged`) = `./config/web2d` under the project; packaged = `<appData>/web2d`. Model/tuning TOMLs are **tracked**; only `local.toml` is gitignored. Files seed on first run.
- **`config.toml`** — model-independent knobs merged over `DEFAULT_CONFIG` (feel/gains, `physics`, `eyes`, `jaw`, `renderFps`/`detectFps`, `camera`, `cursorLook`, `lockHotkey`/`recenterHotkey`, `hyprlandAutoBind`, `showFps`/`showExpressions`), plus `model` = the active model name. Unrecognized keys survive the rewrite.
- **`models/<name>.toml`** — everything model-dependent: `location`/`model` (both **required**; an unknown/typo'd active model loads nothing and **no file is created**), a `[gain]` table, and `[expressions.<name>]` tables (`file`/`key`/`active`). `location` is usually an **absolute** path outside the project (see the model protocol below), so the tracked profiles come in per-machine variants (`zero.toml` / `zero-linux.toml`) that differ only in that path. First load centers the model at scale 1; the live transform goes to `local.toml`. `DEFAULT_MODEL_CONFIG` is intentionally **blank**.
- **Several model values are derived from the model's own `physics3.json`, not authored.** On load, `electron/config.ts` resolves `model3.json` → `FileReferences.Physics` → the `physics3.json` and derives: `[gain]` (one entry per physics setting name from `Meta.PhysicsDictionary`, default `1`, whose output params the rig scales away from rest); `headAngle` (if physics *outputs* `ParamAngle*`, writes are redirected to the physics *input* that feeds it, else written direct); and `physicsBodyParams` (`ParamBodyAngle*` physics already derives from the head — the rig must not override those or the lean inverts). Only the `[gain]` multipliers are persisted; the rest is recomputed every load.
- **Expression discovery is runtime**: scans `location` for `*.exp3.json`, keeps saved `key`/`active`, assigns keys 1–0 to new ones, drops vanished ones, writes back when the set changes. The gain/expression write-back only happens for an **existing** file whose model actually loaded — a failed load yields empty discovery, and persisting that would wipe the user's values.
- **Renderer consumes config by injection**: `src/main.ts` awaits `getConfig()`, then passes `config`/`modelConfig` into `createRigDriver`/`setupPhysics`/`startFaceTracking`/`setupCursorLook`/`setupInteraction`/`setupExpressions`. Writes flow back through `pos:report` / `config:set-expression` / `config:set-hotkey` IPC, which patch the TOMLs in place (preserving authored fields). A few keys are re-read **synchronously** per use (`loadHotkeysSync`, `loadUiTogglesSync`, `loadWindowBoundsSync`, `loadHyprlandAutoBindSync`, `loadCursorLookSync`) because they're needed inside the launch tick (an async gap before `createWindow` lets AeroSpace capture the overlay) or so an edit takes effect without a restart.

### Model assets and the custom protocol

Models live in arbitrary directories outside the project, so they're served over a custom **`web2dmodel://`** scheme (`electron/model-protocol.ts`, registered before `ready`; URLs built by `src/model-url.ts`). pixi-live2d-display resolves textures/motions/physics relative to the model URL, so the whole tree comes from disk. Reads are gated to `allowedModelRoots` — the resolved `location` of loaded models — so the renderer can't pull arbitrary files.

MediaPipe wasm + `.task` files and `live2dcubismcore.min.js` live in `public/` (Vite serves them at the root in dev; the worker must load the wasm fileset by **full-origin URL**, see the comments in `face-worker.ts`).

### Persisted files

- `config/web2d/config.toml` + `config/web2d/models/*.toml` — tracked.
- `config/web2d/local.toml` — **gitignored** per-machine volatile state: `[window]` (overlay geometry) and `[pos.<model>]` (live model transform), read/written by the sync helpers in `electron/config.ts`. `loadConfig`/`loadModel` migrate any stale `[window]`/`[pos]` out of the tracked TOMLs.
- `~/.local/share/applications/web2d.desktop` — written on Wayland purely so the portal accepts the app id.
