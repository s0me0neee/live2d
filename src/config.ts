// Shared config types + defaults. Live values are loaded at runtime from TOML
// (electron/config.ts) and sent to the renderer over IPC; these defaults seed
// new files and back-fill missing keys.

export interface Config {
	mirror: boolean;
	// 1€ filter (see src/one-euro-filter.ts) for face-tracking pose only — cursor-look
	// has its own separate lagMs smoothing and doesn't use this. A single fixed time
	// constant can't both kill MediaPipe landmark jitter at rest and track fast real
	// motion without lag; this adapts its cutoff to the signal's own speed instead.
	smoothing: {
		enabled: boolean; // false = raw passthrough, binds exactly to each detection frame
		minCutoff: number; // Hz. Filtering strength at rest — lower = smoother idle but
		// duller on slow real motion, higher = crisper but jitterier idle.
		beta: number; // how fast filtering backs off as motion speeds up — higher = less
		// lag on fast motion, at the cost of jitter reappearing then.
		dCutoff: number; // smooths the internal velocity estimate; rarely needs changing.
	};

	headGain: number;
	headClampDeg: number;

	bodyFollow: number;
	breath: number;

	physics: {
		windEnabled: boolean;
		wind: { x: number; y: number };
		gust: number;
		gustHz: number;
		springiness: number;
	};

	eyes: { deadzone: number; curve: number; gain: number; gazeGain: number };
	// deadzone/openMax bound the raw geometric mouth-open ratio (3D distance between
	// the inner-lip landmarks, normalized by 3D interocular distance — see
	// face-geometry.ts) before curve/gain shaping. Values are on that ratio's own
	// scale, live-tuned against a real face (see face-debug's "mouth" readout), not
	// carried over from the old 0..1 jawOpen blendshape this replaced. Current values
	// are unverified placeholders pending that live retuning.
	jaw: { deadzone: number; openMax: number; curve: number; gain: number };

	renderFps: number;
	detectFps: number;
	camera: { width: number; height: number };

	lockHotkey: string;
	recenterHotkey: string;

	// Linux/Hyprland only: when true, the app runs `hyprctl keyword bind` at startup to
	// bind recenterHotkey to the portal global shortcut (and unbinds on quit), so no
	// hyprland.conf edit is needed. No-op off Linux, or if hyprctl isn't a Hyprland session.
	hyprlandAutoBind: boolean;

	// Make the model watch the mouse when face tracking has nothing to say (no camera,
	// or no face in frame). While click-through the window gets no pointer events at
	// all, so main polls the global cursor at detectFps instead — works everywhere
	// (Electron's `screen` API on macOS/Windows/X11, hyprctl on Hyprland) except a
	// non-Hyprland Wayland session, which has no portable cursor source. Feeds the same
	// rig as face tracking (headClampDeg and bodyFollow apply on top of these), but
	// through its own independent smoothing below, not the face-tracking `smoothing`.
	cursorLook: {
		enabled: boolean;
		range: number; // cursor distance for full deflection, in model heights
		headDeg: number; // head turn at full deflection, same unit as headClampDeg
		eyeGain: number; // >1 saturates the eyes before the head; 2 = at half `range`
		lagMs: number; // follow lag; higher = lazier, 0 = off.
	};

	showFps: boolean;
	showExpressions: boolean;
}

// The two configurable global shortcuts. "" = unbound.
export type HotkeyId = "lock" | "recenter";

export const DEFAULT_CONFIG: Config = {
	mirror: true,
	// Live-tuned: raw tracking already reads well with smoothing off, so this only
	// needs to be light enough to eat detection jitter, not introduce real lag.
	smoothing: { enabled: true, minCutoff: 2.0, beta: 0.02, dCutoff: 1.0 },
	headGain: 1.5,
	headClampDeg: 90,
	bodyFollow: 1 / 3,
	breath: 0.2,
	physics: {
		windEnabled: false,
		wind: { x: 0.03, y: -0.03 },
		gust: 0.05,
		gustHz: 0.5,
		springiness: 1.02,
	},
	eyes: { deadzone: 0, curve: 1, gain: 1.2, gazeGain: 1 },
	jaw: { deadzone: 0.03, openMax: 0.35, curve: 1, gain: 1 },
	renderFps: 120,
	detectFps: 60,
	camera: { width: 1080, height: 960 },
	lockHotkey: "CommandOrControl+Alt+L",
	recenterHotkey: "CommandOrControl+Alt+R",
	hyprlandAutoBind: false,
	cursorLook: { enabled: true, range: 1.5, headDeg: 24, eyeGain: 2, lagMs: 120 },
	showFps: true,
	showExpressions: true,
};

// Live transform persisted as the user drags/zooms.
export interface Pos {
	x: number;
	y: number;
	scale: number;
}

// Overlay window geometry, persisted in config.toml's [window] table.
export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

// One toggleable expression, discovered from a model's *.exp3.json files.
export interface Expression {
	file: string;
	key: string;
	active: boolean;
}

// One physics setting's gain: how far its params swing from rest (1 = default),
// with the output params resolved from the model's .physics3.json.
export interface GainSetting {
	value: number;
	params: string[];
}

export interface ModelConfig {
	location: string; // model dir, relative to project root / cwd (or absolute)
	model: string; // the .model3.json filename inside `location`

	// Absolute `location`, resolved by the main process. The renderer builds the
	// model-asset URLs (custom web2dmodel:// scheme) from this. Derived, not persisted.
	resolvedLocation?: string;

	// Secondary-motion tuning, keyed by physics setting name (discovered from the
	// model's .physics3.json). On disk only the value (multiplier) is stored.
	gain: Record<string, GainSetting>;

	// Param ids the head-pose drives. Normally ParamAngleX/Y/Z, but when the model's
	// physics OUTPUTS those (driving the head as secondary motion) we must instead
	// write the physics INPUT that feeds them, or physics clobbers our value each
	// frame. Discovered from the .physics3.json; not persisted (fully derived).
	headAngle: { x: string; y: string; z: string };

	// ParamBodyAngle* params the model's physics already derives from the head pose.
	// We leave these to physics rather than overriding them with a linear body-follow
	// (which can fight physics and invert the lean). Discovered; not persisted.
	physicsBodyParams: string[];

	pos?: Pos; // absent until the user first drags/zooms → first load centers at scale 1
	expressions: Record<string, Expression>;
}

// Blank template: a model's location and param names are model-specific, so the
// user fills them in models/<name>.toml. An empty config loads no model.
export const DEFAULT_MODEL_CONFIG: Omit<ModelConfig, "expressions" | "pos"> = {
	location: "",
	model: "",
	gain: {},
	headAngle: { x: "ParamAngleX", y: "ParamAngleY", z: "ParamAngleZ" },
	physicsBodyParams: [],
};

export interface ResolvedConfig {
	modelName: string;
	config: Config;
	model: ModelConfig;
}

// A settings-page edit patches only the fields it touched; nested objects (smoothing,
// physics, eyes, jaw, camera, cursorLook) merge key-by-key rather than replacing whole.
export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// Config paths a live overlay session can't re-apply without re-acquiring a resource it
// only sets up once at boot (the camera, the detection worker's throttle, cursor-look's
// async setup gate) — touching one of these reloads the overlay instead of live-applying.
// Shared between electron/main.ts (decides whether to reload) and
// src/settings/fields.ts (labels the field so the reload isn't a surprise), so the two
// can't drift apart the way two hand-maintained copies could.
export const RELOAD_REQUIRED_PATHS: string[][] = [
	["detectFps"],
	["camera", "width"],
	["camera", "height"],
	["cursorLook", "enabled"],
];

export function pathRequiresReload(path: string[]): boolean {
	return RELOAD_REQUIRED_PATHS.some((p) => p.length === path.length && p.every((k, i) => k === path[i]));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

// Merges `source` into `target` in place (not a replace), so callers who closed over
// `target`'s object identity (rig.ts/physics.ts/cursor-look.ts reading config.* fresh
// per frame) see the update without needing every field wired through an apply() call.
export function deepAssign<T extends object>(target: T, source: DeepPartial<T>): void {
	const t = target as Record<string, unknown>;
	const s = source as Record<string, unknown>;
	for (const key of Object.keys(s)) {
		const sv = s[key];
		const tv = t[key];
		if (isPlainObject(sv) && isPlainObject(tv)) {
			deepAssign(tv, sv);
		} else {
			t[key] = sv;
		}
	}
}
