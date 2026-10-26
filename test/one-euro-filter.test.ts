import { describe, expect, test } from "bun:test";
import { createOneEuroFilter, type OneEuroConfig } from "../src/one-euro-filter";

const CFG: OneEuroConfig = { minCutoff: 1, beta: 0, dCutoff: 1 };
const FRAME_MS = 1000 / 30;

function stepFromZero(raw: number, samples: number, cfg = CFG, dtMs = FRAME_MS) {
	const filter = createOneEuroFilter();
	filter.step(0, dtMs, cfg);
	let out = 0;
	for (let i = 0; i < samples; i++) out = filter.step(raw, dtMs, cfg);
	return out;
}

describe("createOneEuroFilter", () => {
	test("first sample passes through", () => {
		expect(createOneEuroFilter().step(42, FRAME_MS, CFG)).toBe(42);
	});

	test("holds a constant signal exactly", () => {
		const filter = createOneEuroFilter();
		for (let i = 0; i < 100; i++) expect(filter.step(3.5, FRAME_MS, CFG)).toBe(3.5);
	});

	test("lags behind a step change, then converges onto it", () => {
		const afterOne = stepFromZero(1, 1);
		expect(afterOne).toBeGreaterThan(0);
		expect(afterOne).toBeLessThan(0.5);
		expect(stepFromZero(1, 500)).toBeCloseTo(1, 6);
	});

	test("higher beta tracks fast motion with less lag", () => {
		expect(stepFromZero(1, 1, { ...CFG, beta: 1 })).toBeGreaterThan(stepFromZero(1, 1));
	});

	test("filters by elapsed time, not sample count", () => {
		expect(stepFromZero(1, 1, CFG, 500)).toBeGreaterThan(stepFromZero(1, 1, CFG, 10));
	});

	test("reset makes the next sample pass through again", () => {
		const filter = createOneEuroFilter();
		filter.step(0, FRAME_MS, CFG);
		filter.step(10, FRAME_MS, CFG);
		filter.reset();
		expect(filter.step(-7, FRAME_MS, CFG)).toBe(-7);
	});

	test("samples sharing a timestamp stay finite", () => {
		const filter = createOneEuroFilter();
		const cfg = { ...CFG, beta: 1 };
		filter.step(0, FRAME_MS, cfg);
		expect(Number.isFinite(filter.step(5, 0, cfg))).toBe(true);
		expect(Number.isFinite(filter.step(5, FRAME_MS, cfg))).toBe(true);
	});
});
