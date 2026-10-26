import { createOneEuroFilter, type OneEuroConfig } from "./one-euro-filter";

// Denoising and upsampling are kept apart: the 1€ filter runs once per detection, timed
// by camera capture timestamps, and the render loop eases toward each filtered result
// over one capture interval. Filtering per render tick instead made one cutoff do both
// jobs, so raising beta to cut lag turned fast motion into a detection-rate staircase.
//
// Easing over the whole interval made the model feel a frame late, so half of each step is
// applied on arrival. Measured on a 30fps camera with 18ms inference (beta 0.5): 42ms lag
// following the raw sample, 62ms easing everything over the interval, 54ms at this value —
// while staying much smoother than the raw sample (staircase RMS 1.67 vs 2.65).
const FEED_THROUGH = 0.5;

export interface FaceSmoother<K extends string> {
	push(sample: Record<K, number>, capturedAtMs: number, nowMs: number): void;
	read(nowMs: number, out: Record<K, number>): void;
	// The next push snaps instead of filtering/easing — for a face regained after a gap.
	reset(): void;
}

// `params` returns null when smoothing is off: samples then pass through unfiltered and
// the output snaps to each one.
export function createFaceSmoother<K extends string>(
	keys: readonly K[],
	params: (key: K) => OneEuroConfig | null,
): FaceSmoother<K> {
	const filters = keys.map(() => createOneEuroFilter());
	const from = {} as Record<K, number>;
	const to = {} as Record<K, number>;
	let lastCapturedAt: number | null = null;
	let seenAt = 0;
	let intervalMs = 0;

	const progress = (nowMs: number) => (intervalMs > 0 ? Math.min(1, (nowMs - seenAt) / intervalMs) : 1);

	return {
		push(sample, capturedAtMs, nowMs) {
			const first = lastCapturedAt === null;
			const captureDt = first ? 0 : capturedAtMs - (lastCapturedAt as number);
			// Arrival time stands in if a camera reports no usable timestamps.
			const dtMs = first ? 0 : captureDt > 0 ? captureDt : nowMs - seenAt;
			const k = progress(nowMs);
			let smoothed = false;
			keys.forEach((key, i) => {
				const p = params(key);
				const step = p ? filters[i].step(sample[key], dtMs, p) : sample[key];
				const current = first ? step : from[key] + (to[key] - from[key]) * k;
				from[key] = first || !p ? step : current + (step - current) * FEED_THROUGH;
				to[key] = step;
				if (p) smoothed = true;
			});
			intervalMs = smoothed && dtMs > 0 ? dtMs : 0;
			lastCapturedAt = capturedAtMs;
			seenAt = nowMs;
		},
		read(nowMs, out) {
			const k = progress(nowMs);
			for (const key of keys) out[key] = from[key] + (to[key] - from[key]) * k;
		},
		reset() {
			lastCapturedAt = null;
			for (const f of filters) f.reset();
		},
	};
}
