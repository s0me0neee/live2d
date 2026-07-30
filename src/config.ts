// Shared config types + defaults. Live values are loaded at runtime from TOML
// (electron/config.ts) and sent to the renderer over IPC; these defaults seed
// new files and back-fill missing keys.

export interface Config {
	mirror: boolean;
	smoothing: number;

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
	// or no face in frame). Linux/Hyprland only: while click-through the window gets no
	// pointer events at all, so the compositor is polled for the global cursor at
	// detectFps instead. Feeds the same rig as face tracking, so headClampDeg,
	// smoothing and bodyFollow all apply on top of these.
	cursorLook: {
		enabled: boolean;
		range: number; // cursor distance for full deflection, in model heights
		headDeg: number; // head turn at full deflection, same unit as headClampDeg
		eyeGain: number; // >1 saturates the eyes before the head; 2 = at half `range`
		lagMs: number; // follow lag; higher = lazier, 0 = off. Stacks on `smoothing`.
	};

	showFps: boolean;
	showExpressions: boolean;
}

// The two configurable global shortcuts. "" = unbound.
export type HotkeyId = "lock" | "recenter";

export const DEFAULT_CONFIG: Config = {
	mirror: true,
	smoothing: 0.55,
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
