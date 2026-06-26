# Plan: TOML config + always-on-top overlay window

## Context

Config currently lives in two hand-written TS files: `src/config.ts`
(model-independent tuning) and `src/model-config.ts` (per-model: paths, scale,
hair/cloth param prefixes). We want the editable source of truth to be TOML
instead — `config.toml` for the model-independent knobs and
`config_<model>.toml` for each model — so non-code edits don't touch `.ts`.
Separately, the app should behave like a desktop avatar overlay: a transparent,
frameless, always-on-top window.

The repo already has a "Rust generates TS on launch" convention:
`src-tauri/src/build_exp_keys.rs` scans the model dir and emits
`src/expressions/generated.ts`, and `main.rs` runs it at startup. We follow the
same pattern for config so the frontend keeps fully-typed `config` /
`modelConfig` objects and zero new runtime dependency.

---

## Part 1 — TOML config (Rust generates the TS)

### File layout (repo root)

- `config.toml` — model-independent. Has a `model = "ariu"` selector key.
- `config_ariu.toml` — model-dependent (one per model; selected by the key above).

### `config.toml` (mirrors today's `config.ts` shape exactly)

```toml
model = "ariu"          # selects config_<model>.toml (stripped from generated TS)

mirror = true
smoothing = 0.6
headGain = 1.5
headClampDeg = 90
bodyFollow = 0.333333
breath = 0.5
blinkGain = 1.4
detectFps = 60

[jaw]
deadzone = 0.004
curve = 0.23
gain = 1.1

[camera]
width = 640
height = 480

[physics]
windEnabled = false
gust = 0.05
gustHz = 0.5
springiness = 1.02

[physics.wind]
x = 0.03
y = -0.03
```

### `config_ariu.toml` (mirrors today's `model-config.ts`)

```toml
dir = "/model/ariu/"
file = "ariu.model3.json"
scale = 0.2

[hair]
prefix = "ParamHair"
gain = 1.7

[clothes]
prefix = "Param_Angle_Rotation"
gain = 2.0
```

Keys are kept identical to the current TS so **no consumer changes** are needed
(`config.headGain`, `config.physics.wind.x`, `modelConfig.hair.prefix`, etc.).
TOML rule: all bare scalars must precede the first `[table]` — values above are
already ordered that way.
