import { describe, expect, test } from "bun:test";
import { createFaceSmoother } from "../src/face-smoother";
import type { OneEuroConfig } from "../src/one-euro-filter";

type Key = "x";
const KEYS: Key[] = ["x"];
// A cutoff this high makes the 1€ filter a passthrough, isolating the easing.
const PASSTHROUGH: OneEuroConfig = { minCutoff: 1e9, beta: 0, dCutoff: 1 };
const SMOOTH: OneEuroConfig = { minCutoff: 1, beta: 0, dCutoff: 1 };

function smoother(params: OneEuroConfig | null = PASSTHROUGH) {
	const s = createFaceSmoother(KEYS, () => params);
	const read = (now: number) => {
		const out = { x: NaN };
		s.read(now, out);
		return out.x;
	};
	const push = (x: number, capturedAt: number, now: number) => s.push({ x }, capturedAt, now);
	return { s, read, push };
}

describe("createFaceSmoother", () => {
	test("the first sample is output as-is", () => {
		const { read, push } = smoother();
		push(5, 0, 100);
		expect(read(100)).toBe(5);
	});

	test("applies half of each step on arrival, easing the rest over one interval", () => {
		const { read, push } = smoother();
		push(0, 0, 100);
		push(10, 40, 150);
		expect(read(150)).toBeCloseTo(5, 6);
		expect(read(170)).toBeCloseTo(7.5, 6);
		expect(read(190)).toBeCloseTo(10, 6);
		expect(read(500)).toBeCloseTo(10, 6);
	});

	test("a sample arriving mid-ease closes half the remaining gap, then converges", () => {
		const { read, push } = smoother();
		push(0, 0, 100);
		push(10, 40, 150);
		const before = read(160);
		push(20, 80, 160);
		const after = read(160);
		expect(after).toBeGreaterThan(before);
		expect(after - before).toBeCloseTo((20 - before) / 2, 6);
		expect(read(200)).toBeCloseTo(20, 6);
	});

	test("with smoothing off, the output snaps to every sample", () => {
		const { read, push } = smoother(null);
		push(0, 0, 100);
		push(10, 40, 150);
		expect(read(150)).toBe(10);
	});

	test("reset makes the next sample snap", () => {
		const { s, read, push } = smoother(SMOOTH);
		push(0, 0, 100);
		push(1, 40, 150);
		s.reset();
		push(50, 10_000, 10_000);
		expect(read(10_000)).toBe(50);
	});

	test("falls back to arrival times when capture timestamps don't advance", () => {
		const { read, push } = smoother();
		push(0, 0, 100);
		push(10, 0, 140);
		expect(read(160)).toBeCloseTo(7.5, 6);
		expect(read(180)).toBeCloseTo(10, 6);
	});

	test("filtering is timed by capture timestamps, not arrival jitter", () => {
		const steady = smoother(SMOOTH);
		const jittery = smoother(SMOOTH);
		const samples = [0, 3, 7, 12, 18, 25];
		samples.forEach((x, i) => {
			steady.push(x, i * 33, 1000 + i * 33);
			jittery.push(x, i * 33, 1000 + i * 33 + (i % 2 ? 9 : -4));
		});
		expect(steady.read(5000)).toBeCloseTo(jittery.read(5000), 9);
	});
});
