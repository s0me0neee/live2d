import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { DEFAULT_CONFIG, DEFAULT_MODEL_CONFIG } from "../src/config";

const CONFIG_MODULE = join(import.meta.dir, "../electron/config.ts");
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
const REAL_XDG = process.env.XDG_CONFIG_HOME;

let root: string;
let home: string;
let appData: string;

mock.module("electron", () => ({
	app: { getPath: (name: string) => ({ home, appData })[name] },
}));

let importCount = 0;
// config.ts resolves its paths at module load, so every test needs its own instance.
const importConfig = (): Promise<typeof import("../electron/config")> =>
	import(`${CONFIG_MODULE}?instance=${importCount++}`);

function setPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { ...REAL_PLATFORM, value: platform });
	appData =
		platform === "darwin" ? join(home, "Library", "Application Support")
		: platform === "win32" ? join(home, "AppData", "Roaming")
		: join(home, ".config");
}

function writeFile(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const writeToml = (path: string, data: Record<string, unknown>) => writeFile(path, stringify(data));
const readToml = (path: string) => parse(readFileSync(path, "utf8")) as Record<string, any>;

// Silences the logger's expected warnings/errors for scenarios that provoke them.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		return await fn();
	} finally {
		stderr.mockRestore();
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "web2d-test-"));
	home = join(root, "home");
	delete process.env.XDG_CONFIG_HOME;
	setPlatform("darwin");
});

afterEach(() => {
	Object.defineProperty(process, "platform", REAL_PLATFORM);
	if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = REAL_XDG;
	rmSync(root, { recursive: true, force: true });
});

interface ResolutionCase {
	name: string;
	platform: NodeJS.Platform;
	xdg?: () => string;
	expectedDir: () => string;
}

describe("ensureConfigFile", () => {
	const homeConfig = () => join(home, ".config", "web2d");

	test.each<ResolutionCase>([
		{ name: "macOS uses ~/.config, not Application Support", platform: "darwin", expectedDir: homeConfig },
		{ name: "Linux uses ~/.config", platform: "linux", expectedDir: homeConfig },
		{
			name: "an absolute XDG_CONFIG_HOME takes precedence",
			platform: "darwin",
			xdg: () => join(root, "xdg"),
			expectedDir: () => join(root, "xdg", "web2d"),
		},
		{ name: "a relative XDG_CONFIG_HOME is ignored", platform: "linux", xdg: () => "relative/xdg", expectedDir: homeConfig },
		{ name: "Windows uses %APPDATA%", platform: "win32", expectedDir: () => join(appData, "web2d") },
	])("$name", async ({ platform, xdg, expectedDir }) => {
		setPlatform(platform);
		if (xdg) process.env.XDG_CONFIG_HOME = xdg();
		writeToml(join(expectedDir(), "config.toml"), {});
		const { ensureConfigFile } = await importConfig();

		expect(() => ensureConfigFile()).not.toThrow();
	});

	test("throws naming the expected path when config.toml is missing, creating nothing", async () => {
		writeToml(join(appData, "web2d", "config.toml"), { model: "legacy" });
		const { ensureConfigFile } = await importConfig();

		expect(() => ensureConfigFile()).toThrow(join(homeConfig(), "config.toml"));
		expect(existsSync(join(home, ".config"))).toBe(false);
	});
});

describe("with a config dir", () => {
	let configDir: string;
	let modelDir: string;

	beforeEach(() => {
		configDir = join(home, ".config", "web2d");
		modelDir = join(root, "models", "cat");
	});

	function writeModelFixture(profile: Record<string, unknown> = {}) {
		writeToml(join(configDir, "config.toml"), { model: "cat" });
		writeToml(join(configDir, "models", "cat.toml"), { location: modelDir, model: "cat.model3.json", ...profile });
		writeFile(join(modelDir, "cat.model3.json"), JSON.stringify({ FileReferences: { Physics: "cat.physics3.json" } }));
		writeFile(
			join(modelDir, "cat.physics3.json"),
			JSON.stringify({
				Meta: {
					PhysicsDictionary: [
						{ Id: "PhysicsSetting1", Name: "Hair" },
						{ Id: "PhysicsSetting2", Name: "Head" },
					],
				},
				PhysicsSettings: [
					{
						Id: "PhysicsSetting1",
						Input: [{ Source: { Id: "ParamAngleX" } }],
						Output: [{ Destination: { Id: "ParamHairFront" } }],
					},
					{
						Id: "PhysicsSetting2",
						Input: [{ Source: { Id: "ParamBreath" } }, { Source: { Id: "ParamHeadX" } }],
						Output: [{ Destination: { Id: "ParamAngleX" } }, { Destination: { Id: "ParamBodyAngleX" } }],
					},
				],
			}),
		);
		writeFile(join(modelDir, "blush.exp3.json"), "{}");
		writeFile(join(modelDir, "tears.exp3.json"), "{}");
	}

	test("loadConfig back-fills defaults and keeps unknown keys on disk", async () => {
		writeToml(join(configDir, "config.toml"), { model: "none", renderFps: 30, customKey: "kept" });
		const { loadConfig } = await importConfig();

		const { config, modelName } = await quietly(() => loadConfig());
		expect(modelName).toBe("none");
		expect(config.renderFps).toBe(30);
		expect(config.smoothing).toEqual(DEFAULT_CONFIG.smoothing);

		const onDisk = readToml(join(configDir, "config.toml"));
		expect(onDisk.customKey).toBe("kept");
		expect(onDisk.detectFps).toBe(DEFAULT_CONFIG.detectFps);
	});

	test("loadConfig derives gain, head routing and expressions from the model files", async () => {
		writeModelFixture({
			gain: { Hair: 0.5 },
			expressions: {
				tears: { file: "tears.exp3.json", key: "1", active: true },
				vanished: { file: "vanished.exp3.json", key: "2", active: false },
			},
		});
		const { loadConfig } = await importConfig();

		const { model } = await loadConfig();
		expect(model.resolvedLocation).toBe(modelDir);
		expect(model.gain).toEqual({
			Hair: { value: 0.5, params: ["ParamHairFront"] },
			Head: { value: 1, params: ["ParamAngleX", "ParamBodyAngleX"] },
		});
		expect(model.headAngle).toEqual({ ...DEFAULT_MODEL_CONFIG.headAngle, x: "ParamHeadX" });
		expect(model.physicsBodyParams).toEqual(["ParamBodyAngleX"]);
		expect(model.expressions).toEqual({
			blush: { file: "blush.exp3.json", key: "2", active: false },
			tears: { file: "tears.exp3.json", key: "1", active: true },
		});

		const onDisk = readToml(join(configDir, "models", "cat.toml"));
		expect(onDisk.gain).toEqual({ Hair: 0.5, Head: 1 });
		expect(Object.keys(onDisk.expressions).sort()).toEqual(["blush", "tears"]);
	});

	test("loadConfig never writes back discovery for a model whose files are missing", async () => {
		const modelToml = join(configDir, "models", "cat.toml");
		writeToml(join(configDir, "config.toml"), { model: "cat" });
		writeToml(modelToml, {
			location: join(root, "nowhere"),
			model: "cat.model3.json",
			gain: { Hair: 0.5 },
		});
		const before = readFileSync(modelToml, "utf8");
		const { loadConfig } = await importConfig();

		const { model } = await quietly(() => loadConfig());
		expect(model.gain).toEqual({});
		expect(readFileSync(modelToml, "utf8")).toBe(before);
	});

	test("a pre-existing [smoothing] keeps its head values and gains default eyes/mouth groups", async () => {
		writeToml(join(configDir, "config.toml"), {
			model: "none",
			smoothing: { enabled: true, minCutoff: 1.8, beta: 0.14, dCutoff: 1.7 },
		});
		const { loadConfig } = await importConfig();

		const { config } = await quietly(() => loadConfig());
		const expected = {
			enabled: true,
			minCutoff: 1.8,
			beta: 0.14,
			dCutoff: 1.7,
			eyes: DEFAULT_CONFIG.smoothing.eyes,
			mouth: DEFAULT_CONFIG.smoothing.mouth,
		};
		expect(config.smoothing).toEqual(expected);
		expect(readToml(join(configDir, "config.toml")).smoothing).toEqual(expected);
	});

	test("updateConfig merges nested tables instead of replacing them", async () => {
		writeToml(join(configDir, "config.toml"), { smoothing: { minCutoff: 3, beta: 0.1 } });
		const { updateConfig } = await importConfig();

		await updateConfig({ smoothing: { beta: 0.5 } });
		expect(readToml(join(configDir, "config.toml")).smoothing).toEqual({ minCutoff: 3, beta: 0.5 });
	});

	test("an empty hotkey stays unbound, an absent one falls back to the default", async () => {
		writeToml(join(configDir, "config.toml"), {});
		const { setHotkey, loadHotkeysSync } = await importConfig();

		await setHotkey("lock", "");
		expect(loadHotkeysSync()).toEqual({ lock: "", recenter: DEFAULT_CONFIG.recenterHotkey });
	});

	test("window bounds round-trip through local.toml and reject partial tables", async () => {
		writeToml(join(configDir, "config.toml"), {});
		const { saveWindowBoundsSync, loadWindowBoundsSync } = await importConfig();

		expect(loadWindowBoundsSync()).toBeNull();
		saveWindowBoundsSync({ x: 1, y: 2, width: 300, height: 400 });
		expect(loadWindowBoundsSync()).toEqual({ x: 1, y: 2, width: 300, height: 400 });

		writeToml(join(configDir, "local.toml"), { window: { x: 1, y: 2 } });
		expect(loadWindowBoundsSync()).toBeNull();
	});

	test("the model transform is saved per active model and restored on load", async () => {
		writeModelFixture();
		const { loadConfig, savePosSync } = await importConfig();

		await loadConfig();
		savePosSync({ x: 10, y: 20, scale: 0.5 });
		expect(readToml(join(configDir, "local.toml")).pos).toEqual({ cat: { x: 10, y: 20, scale: 0.5 } });
		expect((await loadConfig()).model.pos).toEqual({ x: 10, y: 20, scale: 0.5 });
	});
});
