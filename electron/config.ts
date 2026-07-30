import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { app } from "electron";
import { parse, stringify } from "smol-toml";
import { createLogger, color } from "./log";
import {
	DEFAULT_CONFIG,
	DEFAULT_MODEL_CONFIG,
	type Config,
	type Expression,
	type GainSetting,
	type HotkeyId,
	type ModelConfig,
	type Pos,
	type ResolvedConfig,
	type WindowBounds,
} from "../src/config";

// Dev: the project's ./config dir stands in for the platform config root, so the
// app dir is ./config/web2d. Packaged: the per-user app-data dir.
const appConfigDir = app.isPackaged
	? join(app.getPath("appData"), "web2d")
	: resolve(process.cwd(), "config", "web2d");
const configFile = join(appConfigDir, "config.toml");
const modelsDir = join(appConfigDir, "models");
// Volatile per-machine state (window geometry + live model transform). Kept out of the
// tracked config/model TOMLs — gitignored — so it doesn't churn git or carry another
// machine's absolute geometry.
const localStateFile = join(appConfigDir, "local.toml");

function readLocalStateSync(): Record<string, unknown> {
	try {
		const parsed = parse(readFileSync(localStateFile, "utf8"));
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeLocalStateSync(state: Record<string, unknown>): void {
	mkdirSync(appConfigDir, { recursive: true });
	writeFileSync(localStateFile, stringify(state));
}

const EXP_SUFFIX = ".exp3.json";
const EXPRESSION_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

const log = createLogger("config");

let activeModelName = "";

export async function loadConfig(): Promise<ResolvedConfig> {
	await mkdir(modelsDir, { recursive: true });

	const root = await readToml(configFile);
	const modelName = typeof root.model === "string" ? root.model : "ariu";
	delete root.window; // migrated to local.toml; drop any stale copy from an old config
	const config = mergeDefaults(DEFAULT_CONFIG, root);
	// Spread `root` first so any unrecognized keys survive the rewrite.
	await writeToml(configFile, { ...root, model: modelName, ...config });

	activeModelName = modelName;
	const model = await loadModel(modelName);
	return { modelName, config, model };
}

// Synchronous so the window can be created in the same launch tick (an async
// gap before createWindow lets the AeroSpace WM capture the overlay on macOS).
export function loadWindowBoundsSync(): WindowBounds | null {
	return parseBounds(readLocalStateSync().window);
}

// Async only to match its debounced caller; local.toml is tiny, so the write is sync.
export async function saveWindowBounds(bounds: WindowBounds): Promise<void> {
	saveWindowBoundsSync(bounds);
}

// The quit path (will-quit) can't await; on Linux the final geometry is read from the
// compositor there.
export function saveWindowBoundsSync(bounds: WindowBounds): void {
	try {
		const state = readLocalStateSync();
		state.window = bounds;
		writeLocalStateSync(state);
	} catch (e) {
		log.warn("saveWindowBoundsSync failed:", e);
	}
}

const HOTKEY_TOML_KEY: Record<HotkeyId, "lockHotkey" | "recenterHotkey"> = {
	lock: "lockHotkey",
	recenter: "recenterHotkey",
};

// Read synchronously so the hotkeys can be registered in the same launch tick as
// the window (see loadWindowBoundsSync). An explicit "" is preserved (= unbound);
// only an absent/non-string value falls back to the default.
export function loadHotkeysSync(): Record<HotkeyId, string> {
	const read = (root: Record<string, unknown>, id: HotkeyId): string => {
		const tomlKey = HOTKEY_TOML_KEY[id];
		const v = root[tomlKey];
		return typeof v === "string" ? v : DEFAULT_CONFIG[tomlKey];
	};
	try {
		const root = parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		return { lock: read(root, "lock"), recenter: read(root, "recenter") };
	} catch {
		return { lock: DEFAULT_CONFIG.lockHotkey, recenter: DEFAULT_CONFIG.recenterHotkey };
	}
}

export async function setHotkey(id: HotkeyId, accelerator: string): Promise<void> {
	const root = await readToml(configFile);
	root[HOTKEY_TOML_KEY[id]] = accelerator;
	await writeToml(configFile, root);
}

// Read synchronously so the Linux global-shortcut setup runs in the launch tick.
export function loadHyprlandAutoBindSync(): boolean {
	try {
		const root = parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		return typeof root.hyprlandAutoBind === "boolean"
			? root.hyprlandAutoBind
			: DEFAULT_CONFIG.hyprlandAutoBind;
	} catch {
		return DEFAULT_CONFIG.hyprlandAutoBind;
	}
}

// Just the two keys the main-process cursor poller needs, read fresh on each lock so
// an edit takes effect without a restart. The renderer gets `range`/`gain` the normal
// way, through config:get.
export function loadCursorLookSync(): { enabled: boolean; fps: number } {
	const fallback = { enabled: DEFAULT_CONFIG.cursorLook.enabled, fps: DEFAULT_CONFIG.detectFps };
	try {
		const root = parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		const look = isObject(root.cursorLook) ? root.cursorLook : {};
		return {
			enabled: typeof look.enabled === "boolean" ? look.enabled : fallback.enabled,
			fps: typeof root.detectFps === "number" ? root.detectFps : fallback.fps,
		};
	} catch {
		return fallback;
	}
}

export type UiToggle = "showFps" | "showExpressions";

// Read synchronously so the tray's initial checkbox state is ready in the launch tick.
export function loadUiTogglesSync(): Record<UiToggle, boolean> {
	const pick = (root: Record<string, unknown>, key: UiToggle) =>
		typeof root[key] === "boolean" ? (root[key] as boolean) : DEFAULT_CONFIG[key];
	try {
		const root = parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		return { showFps: pick(root, "showFps"), showExpressions: pick(root, "showExpressions") };
	} catch {
		return { showFps: DEFAULT_CONFIG.showFps, showExpressions: DEFAULT_CONFIG.showExpressions };
	}
}

export async function saveUiToggle(key: UiToggle, value: boolean): Promise<void> {
	const root = await readToml(configFile);
	root[key] = value;
	await writeToml(configFile, root);
}

// The live model transform is per-machine, so it lives in local.toml keyed by model
// name, not the tracked model TOML. Sync so it can run inside `will-quit`; persisted
// only at drag-stop / quit (in-memory during use) to avoid disk churn while dragging.
export function savePosSync(pos: Pos): void {
	try {
		const state = readLocalStateSync();
		const positions = isObject(state.pos) ? state.pos : {};
		positions[activeModelName] = pos;
		state.pos = positions;
		writeLocalStateSync(state);
	} catch (e) {
		log.warn("savePosSync failed:", e);
	}
}

function loadPosSync(name: string): Pos | undefined {
	const positions = readLocalStateSync().pos;
	return isObject(positions) ? parsePos(positions[name]) : undefined;
}

export async function setExpressionActive(name: string, active: boolean): Promise<void> {
	await patchModel((raw) => {
		const expressions = isObject(raw.expressions) ? raw.expressions : {};
		const prev = isObject(expressions[name]) ? expressions[name] : {};
		expressions[name] = { ...prev, active };
		raw.expressions = expressions;
	});
}

async function loadModel(name: string): Promise<ModelConfig> {
	const file = modelFile(name);
	const existed = existsSync(file);
	const raw = await readToml(file);

	const location = asString(raw.location, DEFAULT_MODEL_CONFIG.location);
	const modelJson = asString(raw.model, DEFAULT_MODEL_CONFIG.model);

	const savedGain = parseGain(raw.gain);
	const savedExpressions = parseExpressions(raw.expressions);

	const physics = await loadPhysics(location, modelJson);
	const routing = discoverPhysicsRouting(physics);
	const model: ModelConfig = {
		location,
		model: modelJson,
		gain: discoverGain(physics, savedGain),
		headAngle: routing.headAngle,
		physicsBodyParams: routing.physicsBodyParams,
		expressions: await discoverExpressions(location, savedExpressions),
	};
	if (location) model.resolvedLocation = resolveModelDir(location);
	const pos = loadPosSync(name);
	if (pos) model.pos = pos;

	const loadable = isModelLoadable(model);

	// Persist discovered gain settings + expressions back into an EXISTING file only,
	// and only when the model actually loaded. A failed load (e.g. the model was moved
	// out of `location`) yields empty discovery; writing that back would wipe the
	// user's saved gain/expressions. Also never create a file for a missing/invalid
	// model name — that just litters the models dir.
	const changed =
		keysChanged(savedGain, model.gain) || keysChanged(savedExpressions, model.expressions);
	if (existed && loadable && changed) {
		delete raw.pos; // migrated to local.toml; strip any stale copy from an old model TOML
		raw.gain = toGainToml(model.gain);
		raw.expressions = model.expressions;
		await writeToml(file, raw);
	}
	return model;
}

// Resolve the model's .model3.json → its .physics3.json and parse it once, shared
// by the gain and routing discovery below. null when there's no physics file.
// `any`: physics3.json is free-form vendor JSON we probe defensively below.
async function loadPhysics(location: string, modelJson: string): Promise<any | null> {
	const dir = resolveModelDir(location);
	const physicsFile = (await readJson(join(dir, modelJson)))?.FileReferences?.Physics;
	if (typeof physicsFile !== "string") return null;
	return readJson(join(dir, physicsFile));
}

// Group each physics setting's output params by the setting's human name. Each
// group keeps the user's saved multiplier (default 1 = no change).
function discoverGain(physics: any, saved: Record<string, number>): Record<string, GainSetting> {
	if (!physics) return {};

	const settingNames: Record<string, string> = {};
	for (const entry of physics.Meta?.PhysicsDictionary ?? []) {
		settingNames[entry.Id] = entry.Name;
	}

	const paramsByName: Record<string, Set<string>> = {};
	for (const setting of physics.PhysicsSettings ?? []) {
		const outputs = setting.Output ?? [];
		if (!outputs.length) continue; // nothing to scale
		const name = settingNames[setting.Id] ?? setting.Id;
		const params = (paramsByName[name] ??= new Set());
		for (const output of outputs) {
			const id = output?.Destination?.Id;
			if (typeof id === "string") params.add(id);
		}
	}

	const out: Record<string, GainSetting> = {};
	for (const [name, params] of Object.entries(paramsByName)) {
		out[name] = {
			value: typeof saved[name] === "number" ? saved[name] : 1,
			params: [...params],
		};
	}
	return out;
}

const toGainToml = (gain: Record<string, GainSetting>): Record<string, number> =>
	Object.fromEntries(Object.entries(gain).map(([name, g]) => [name, g.value]));

// Inspect the model's physics to learn how to route head/body:
//   - headAngle: if physics OUTPUTS a ParamAngle*, the head is physics-driven, so
//     we redirect the write to the physics INPUT that feeds it; else drive it direct.
//   - physicsBodyParams: ParamBodyAngle* the physics already derives from the head
//     pose. We must NOT override those (their polarity/amount is the rigger's), or
//     the body fights physics and can swing the wrong way.
function discoverPhysicsRouting(physics: any): {
	headAngle: ModelConfig["headAngle"];
	physicsBodyParams: string[];
} {
	const fallback = { headAngle: DEFAULT_MODEL_CONFIG.headAngle, physicsBodyParams: [] };
	if (!physics) return fallback;

	const inputFor: Record<string, string> = {};
	const bodyOutputs = new Set<string>();
	for (const setting of physics.PhysicsSettings ?? []) {
		const outputs = (setting.Output ?? [])
			.map((o: any) => o?.Destination?.Id)
			.filter((id: unknown): id is string => typeof id === "string");
		const inputs = (setting.Input ?? [])
			.map((i: any) => i?.Source?.Id)
			.filter((id: unknown): id is string => typeof id === "string");
		// Breath is a secondary input on head settings; the head pose feeds the other.
		const headInput = inputs.find((id: string) => id !== "ParamBreath") ?? inputs[0];

		for (const id of outputs) {
			if (id.startsWith("ParamBodyAngle")) bodyOutputs.add(id);
		}
		if (headInput) {
			for (const target of ["ParamAngleX", "ParamAngleY", "ParamAngleZ"]) {
				if (outputs.includes(target) && !inputFor[target]) inputFor[target] = headInput;
			}
		}
	}

	return {
		headAngle: {
			x: inputFor.ParamAngleX ?? fallback.headAngle.x,
			y: inputFor.ParamAngleY ?? fallback.headAngle.y,
			z: inputFor.ParamAngleZ ?? fallback.headAngle.z,
		},
		physicsBodyParams: [...bodyOutputs],
	};
}

// Keep saved key/active for files still present, drop vanished ones, assign a
// free key (1-0) to newly found ones.
async function discoverExpressions(
	location: string,
	saved: Record<string, Expression>,
): Promise<Record<string, Expression>> {
	let files: string[];
	try {
		files = (await readdir(resolveModelDir(location)))
			.filter((f) => f.endsWith(EXP_SUFFIX))
			.sort();
	} catch {
		return {};
	}

	const out: Record<string, Expression> = {};
	const usedKeys = new Set<string>();
	for (const file of files) {
		const name = file.slice(0, -EXP_SUFFIX.length);
		const prev = saved[name];
		if (prev) {
			out[name] = { file, key: prev.key, active: prev.active };
			if (prev.key) usedKeys.add(prev.key);
		}
	}

	const freeKeys = EXPRESSION_KEYS.filter((k) => !usedKeys.has(k));
	let nextKey = 0;
	for (const file of files) {
		const name = file.slice(0, -EXP_SUFFIX.length);
		if (out[name]) continue;
		out[name] = { file, key: freeKeys[nextKey++] ?? "", active: false };
	}
	return out;
}

const keysChanged = (a: object, b: object): boolean =>
	Object.keys(a).sort().join(",") !== Object.keys(b).sort().join(",");

async function patchModel(mutate: (raw: Record<string, unknown>) => void): Promise<void> {
	const file = modelFile(activeModelName);
	const raw = await readToml(file);
	mutate(raw);
	await writeToml(file, raw);
}

// Whether the model's files are actually present (and warn if not). Used to gate the
// gain/expression write-back: a model that can't load yields empty discovery, and
// persisting that would wipe the user's saved values.
function isModelLoadable(m: ModelConfig): boolean {
	if (!m.location || !m.model) {
		log.warn("model needs both `location` and `model` to load");
		return false;
	}
	if (!m.model.endsWith(".model3.json")) {
		log.warn(`"${m.model}" is not a .model3.json file`);
	}
	const modelPath = join(resolveModelDir(m.location), m.model);
	if (!existsSync(modelPath)) {
		log.error(`model file not found: ${color.dim(modelPath)}`);
		return false;
	}
	return true;
}

const modelFile = (name: string) => join(modelsDir, `${name}.toml`);
const resolveModelDir = (location: string) =>
	isAbsolute(location) ? location : resolve(process.cwd(), location);

async function readToml(file: string): Promise<Record<string, unknown>> {
	try {
		const parsed = parse(await readFile(file, "utf8"));
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function writeToml(file: string, data: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, stringify(data));
}

async function readJson(file: string): Promise<any> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

// Walk the default's shape, overriding with `src` where present. Keys the
// default doesn't declare (e.g. config.toml's `model`) can't leak through.
function mergeDefaults<T>(def: T, src: unknown): T {
	if (!isObject(def) || !isObject(src)) {
		return src === undefined ? def : (src as T);
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(def)) {
		out[key] = mergeDefaults((def as Record<string, unknown>)[key], src[key]);
	}
	return out as T;
}

function parseGain(v: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isObject(v)) return out;
	for (const [pattern, value] of Object.entries(v)) {
		if (typeof value === "number") out[pattern] = value;
	}
	return out;
}

function parsePos(v: unknown): Pos | undefined {
	if (!isObject(v)) return undefined;
	const { x, y, scale } = v;
	if (typeof x === "number" && typeof y === "number" && typeof scale === "number") {
		return { x, y, scale };
	}
	return undefined;
}

function parseBounds(v: unknown): WindowBounds | null {
	if (!isObject(v)) return null;
	const { x, y, width, height } = v;
	if (
		typeof x === "number" &&
		typeof y === "number" &&
		typeof width === "number" &&
		typeof height === "number"
	) {
		return { x, y, width, height };
	}
	return null;
}

function parseExpressions(v: unknown): Record<string, Expression> {
	const out: Record<string, Expression> = {};
	if (!isObject(v)) return out;
	for (const [name, raw] of Object.entries(v)) {
		if (!isObject(raw)) continue;
		out[name] = {
			file: asString(raw.file, `${name}${EXP_SUFFIX}`),
			key: asString(raw.key, ""),
			active: raw.active === true,
		};
	}
	return out;
}

const asString = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
