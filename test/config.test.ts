import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, deepAssign, pathRequiresReload, type Config } from "../src/config";

describe("deepAssign", () => {
	test("merges nested objects key by key, keeping their identity", () => {
		const config: Config = structuredClone(DEFAULT_CONFIG);
		const smoothing = config.smoothing;
		deepAssign(config, { smoothing: { beta: 0.5 }, renderFps: 30 });
		expect(config.smoothing).toBe(smoothing);
		expect(config.smoothing).toEqual({ ...DEFAULT_CONFIG.smoothing, beta: 0.5 });
		expect(config.renderFps).toBe(30);
		expect(config.detectFps).toBe(DEFAULT_CONFIG.detectFps);
	});

	test("replaces a non-object target value wholesale", () => {
		const target: Record<string, unknown> = { a: 1 };
		deepAssign(target, { a: { b: 2 } });
		expect(target).toEqual({ a: { b: 2 } });
	});

	test("treats arrays as values, not objects to merge", () => {
		const target = { list: [1, 2, 3] };
		deepAssign(target, { list: [9] });
		expect(target.list).toEqual([9]);
	});
});

describe("pathRequiresReload", () => {
	test("matches listed paths exactly", () => {
		expect(pathRequiresReload(["detectFps"])).toBe(true);
		expect(pathRequiresReload(["camera", "width"])).toBe(true);
	});

	test("rejects prefixes, extensions and unrelated paths", () => {
		expect(pathRequiresReload(["camera"])).toBe(false);
		expect(pathRequiresReload(["camera", "width", "x"])).toBe(false);
		expect(pathRequiresReload(["renderFps"])).toBe(false);
	});
});
