import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { app } from "electron";
import { parse, stringify } from "smol-toml";
import {
	DEFAULT_CONFIG,
	DEFAULT_MODEL_CONFIG,
	type Config,
	type Expression,
	type GainSetting,
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

const EXP_SUFFIX = ".exp3.json";
const EXPRESSION_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

let activeModelName = "";

export async function loadConfig(): Promise<ResolvedConfig> {
	await mkdir(modelsDir, { recursive: true });

	const root = await readToml(configFile);
	const modelName = typeof root.model === "string" ? root.model : "ariu";
	const config = mergeDefaults(DEFAULT_CONFIG, root);
	// Spread `root` first so non-Config keys (e.g. [window]) survive the rewrite.
	await writeToml(configFile, { ...root, model: modelName, ...config });

	activeModelName = modelName;
	const model = await loadModel(modelName);
	return { modelName, config, model };
}

export async function loadWindowBounds(): Promise<WindowBounds | null> {
	return parseBounds((await readToml(configFile)).window);
}

export async function saveWindowBounds(bounds: WindowBounds): Promise<void> {
	const root = await readToml(configFile);
	root.window = bounds;
	await writeToml(configFile, root);
}

export async function savePos(pos: Pos): Promise<void> {
	await patchModel((raw) => {
		raw.pos = pos;
	});
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

	const model: ModelConfig = {
		location,
		model: modelJson,
		gain: await discoverGain(location, modelJson, savedGain),
		expressions: await discoverExpressions(location, savedExpressions),
	};
	const pos = parsePos(raw.pos);
	if (pos) model.pos = pos;

	warnIfUnloadable(model);

	// Persist discovered gain settings + expressions back into an EXISTING file
	// only. Never create one for a missing/invalid model name — that just litters
	// the models dir; an unknown model simply loads nothing.
	const changed =
		keysChanged(savedGain, model.gain) || keysChanged(savedExpressions, model.expressions);
	if (existed && changed) {
		raw.gain = toGainToml(model.gain);
		raw.expressions = model.expressions;
		await writeToml(file, raw);
	}
	return model;
}

// Parse the model's .model3.json → its .physics3.json, then group each physics
// setting's output params by the setting's human name. Each group keeps the
// user's saved multiplier (default 1 = no change).
async function discoverGain(
	location: string,
	modelJson: string,
	saved: Record<string, number>,
): Promise<Record<string, GainSetting>> {
	const dir = resolveModelDir(location);

	const physicsFile = (await readJson(join(dir, modelJson)))?.FileReferences?.Physics;
	if (typeof physicsFile !== "string") return {};
	const physics = await readJson(join(dir, physicsFile));
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

function warnIfUnloadable(m: ModelConfig): void {
	if (!m.location || !m.model) {
		console.warn("[config] model needs both `location` and `model` to load");
		return;
	}
	if (!m.model.endsWith(".model3.json")) {
		console.warn(`[config] "${m.model}" is not a .model3.json file`);
	}
	const modelPath = join(resolveModelDir(m.location), m.model);
	if (!existsSync(modelPath)) console.warn(`[config] model file not found: ${modelPath}`);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
