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

A desktop **Live2D overlay**: a transparent, always-on-top, click-through window that renders a Cubism 4 model driven in real time by webcam face tracking. The window floats over games/the desktop and can be locked (click-through) or unlocked (draggable/zoomable).

Stack: **Electron + Vite + TypeScript + Pixi.js v7 + pixi-live2d-display + MediaPipe Tasks Vision**. Package manager is **pnpm**.

> Note: the repo path (`rust/live2d`) and `README.md` are stale — this was originally a Tauri/Rust app and was rewritten to Electron (see commit history and `plan.md`). Comments throughout reference the original Tauri/DmNote behavior they aim to match; ignore the Rust/Tauri framing, the code is all TS/JS now.

## Commands

```bash
pnpm dev          # build the Electron shell, start Vite, launch Electron (scripts/dev.mjs)
pnpm build        # tsc typecheck + vite build (-> dist/) + bundle main/preload (-> dist-electron/)
pnpm start        # run Electron against an existing build
pnpm dev:renderer # Vite only, plain browser (no electronAPI → no config/IPC, so no model loads)
```

There is **no test runner and no linter configured**. `tsc` (run via `pnpm build`) is the only typecheck — TS is strict with `noUnusedLocals`/`noUnusedParameters`. To typecheck without building: `pnpm exec tsc`. Note `tsc` only covers `src/` (per `tsconfig.json`); the `electron/` sources are type-erased by esbuild, not type-checked, so verify main-process changes carefully.

## Architecture

Two processes, built by two separate toolchains:

- **Main + preload** (`electron/`, TypeScript) → bundled to **CommonJS** `dist-electron/{main,preload}.cjs` by **esbuild** (`scripts/build-electron.mjs`). `electron` and `koffi` are kept external (native/can't bundle). `.cjs` extension is deliberate so they stay CommonJS despite `"type": "module"`.
- **Renderer** (`src/`, the Live2D app) → built by **Vite** to `dist/`. Vite `base: "./"` so it loads over `file://` in a packaged app. Dev server is fixed at port **1420** (`vite.config.ts`); `dev.mjs` passes the URL to Electron via `ELECTRON_RENDERER_URL`.

The renderer talks to main only through `electron/preload.ts`, which `contextBridge`-exposes `window.electronAPI` (typed in `src/global.d.ts`). Outside Electron (`pnpm dev:renderer`) `electronAPI` is absent and dependent features feature-detect and no-op.

### Overlay window behavior — the core trick

The hard part of this project is making a borderless, transparent window behave like a true system overlay (float over fullscreen apps, appear on every Space, never steal focus, optionally pass clicks through).

- **macOS** (`electron/mac-overlay.ts`): Electron's window APIs aren't enough, so it reaches into the live `NSWindow` via **raw AppKit FFI** (`koffi` → `objc_msgSend`): sets `NSStatusWindowLevel`, `canJoinAllSpaces | fullScreenAuxiliary` collection behavior, `setHidesOnDeactivate:NO`, `orderFrontRegardless`. AppKit resets these on reorder, so `applyMacOverlay()` is re-applied on `show`/`blur`/`ready-to-show`. `app.setActivationPolicy("accessory")` **must** run at module load (before `whenReady`) or AX window managers latch onto the window.
- **Click-through lock** (`main.ts`): a single boolean `overlayLocked`, toggled from the tray menu, the global hotkey **Cmd/Ctrl+Alt+L**, or renderer IPC (`overlay:toggle-lock` etc.). Locked = `setIgnoreMouseEvents(true, {forward:true})` → clicks fall through, hover still works. The global hotkey is essential: once click-through, the renderer can't receive a click to turn it back off.

The project targets **macOS only**. An earlier Linux click-through approach (renderer streams the model's bounding box; main polls the global cursor against it) was removed because it didn't work — don't reintroduce a per-platform `setOverlayMode`/`reportHitRegion` path without revisiting that.

### Renderer composition (`src/main.ts`)

`main.ts` boots a Pixi `Application` on the `#live2d` canvas (transparent, capped at `config.renderFps`), loads the model, then wires independent feature modules. Face tracking and expressions are `.catch()`-guarded so the app survives camera denial / missing assets:

- `face-tracking.ts` — webcam → MediaPipe FaceLandmarker (blendshapes + transform matrix) → a `Rig` of Live2D params. Inference runs in a Web Worker (`face-worker.ts`, fed the camera frames via a transferred `MediaStreamTrackProcessor` stream) so `detectForVideo` never stalls the render thread; the worker throttles to `config.detectFps` and posts compact results back, while smoothing runs per render frame on the main thread. Writes face params on `afterMotionUpdate` and body/hair/cloth params on `beforeModelUpdate` so they win over (or feed) the physics sim. Reaches into Cubism runtime internals (`internalModel.coreModel`, `setParameterValueById`).
- `physics.ts` — tunes the model's built-in pendulum physics + breath by mutating private Cubism runtime fields (`internal.physics._physicsRig`, `breath._breathParameters`), driven by `config.physics`.
- `interaction.ts` — drag (grabs the model, not the canvas) + scroll-to-zoom (anchored under cursor); restores from / persists `{x,y,scale}` to the model's TOML `[pos]`.
- `expressions/` — independent outfit/face toggles (checkbox panel + number-key shortcuts), applied imperatively on toggle.
- `window-controls.ts` — the move/resize guide shown only when **unlocked**. The frameless/transparent/`focusable:false` window has no native title bar or resize borders, so it drives the OS window from the renderer: snapshot `windowControls.getBounds()` on grab, then translate the pointer's **global** `screenX/screenY` delta into new bounds via `windowControls.setBounds` (coalesced per rAF). Handles `stopPropagation` so grabbing the guide doesn't also trigger Pixi model-drag; the model body stays draggable elsewhere. Main persists bounds to `config.toml`'s `[window]` table (debounced) and restores them in `createWindow`.
- `fps.ts`, `pos-store.ts`.

### Configuration (runtime TOML)

Config is loaded at runtime from TOML by the **main process** (`electron/config.ts`) and handed to the renderer via the `config:get` IPC at boot. `src/config.ts` holds only the shared TS **types + default values** (used to seed files and back-fill missing keys) — it is *not* the live config. `smol-toml` does the parse/stringify.

- **Config dir**: dev (`!app.isPackaged`) = `./config/web2d` under the project; packaged = `<appData>/web2d`. **Gitignored** (carries live state; seeds on first run).
- **`config.toml`** — model-independent knobs, merged over `DEFAULT_CONFIG`, plus `model` = the active model name.
- **`models/<name>.toml`** — everything model-dependent in one file: `location`/`model` (both **required**; an unknown/typo'd active model loads nothing and **no file is created**), a `[gain]` table, `[pos]` (live transform, replaces the old `pos.toml`), and `[expressions.<name>]` tables (`file`/`key`/`active`). First load centers the model at scale 1; `[pos]` persists drag/zoom. `DEFAULT_MODEL_CONFIG` is intentionally **blank**.
- **`[gain]` is physics-derived.** On load, `electron/config.ts` parses the model's `model3.json` → `FileReferences.Physics` → the `physics3.json`, and generates one gain entry per **physics setting name** (`Meta.PhysicsDictionary`), each defaulting to `1` (no change). The renderer resolves each name to that setting's output params and scales their swing-from-rest after physics (`face-tracking.ts`). This replaced the earlier param-id regex matching (the artist's ids were unreliable groupings).
- **Expression discovery is runtime** (`electron/config.ts`): scans `location` for `*.exp3.json`, keeps saved `key`/`active`, assigns keys 1–0 to new ones, drops vanished ones, writes back when the set changes. Replaces the deleted `build-exp-keys.mjs` + `generated.ts`.
- **Renderer consumes config by injection**: `src/main.ts` awaits `getConfig()`, then passes `config`/`modelConfig` into `setupPhysics`/`startFaceTracking`/`setupInteraction`/`setupExpressions`. Writes flow back through `savePos` / `setExpression` IPC, which patch the model TOML (preserving authored fields).

### Persisted files

- Overlay window geometry lives in `config.toml`'s `[window]` table (`loadWindowBounds`/`saveWindowBounds` in `electron/config.ts`), written by main on `window:set-bounds` (debounced), restored in `createWindow`. `loadConfig`'s rewrite preserves it by spreading the existing file before the Config keys.
- `config/web2d/` — config + per-model state (above). **Gitignored**.
- Model assets in `model/<name>/`; MediaPipe wasm + `.task` in `public/mediapipe/`. Both served from the project root by Vite in dev, so `location` is a project-relative path; arbitrary/absolute model dirs would need a custom protocol (not built yet).
