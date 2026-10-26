// 1€ Filter (Casiez, Roussel, Vogel 2012): a speed-adaptive low-pass. The cutoff
// frequency rises with the signal's estimated velocity, so it filters hard on a
// near-static signal (killing jitter) and barely at all during fast real motion
// (killing lag) — the tradeoff a single fixed time constant can't resolve.
export interface OneEuroConfig {
	minCutoff: number; // Hz, filtering strength at zero speed
	beta: number; // how fast the cutoff rises with speed
	dCutoff: number; // Hz, smooths the internal velocity estimate itself
}

export interface OneEuroFilter {
	// Once per real sample, with the time since the previous sample's capture.
	step(raw: number, dtMs: number, cfg: OneEuroConfig): number;
	reset(): void;
}

const TWO_PI = 2 * Math.PI;
const alpha = (cutoffHz: number, dtSec: number): number => 1 / (1 + 1 / (TWO_PI * cutoffHz) / dtSec);

export function createOneEuroFilter(): OneEuroFilter {
	let xHat = 0;
	let dxHat = 0;
	let initialized = false;

	return {
		step(raw, dtMs, cfg) {
			if (!initialized) {
				xHat = raw;
				dxHat = 0;
				initialized = true;
				return xHat;
			}
			// Floored so two samples sharing a timestamp can't poison the state with Infinity/NaN.
			const dtSec = Math.max(dtMs, 1) / 1000;
			dxHat += ((raw - xHat) / dtSec - dxHat) * alpha(cfg.dCutoff, dtSec);
			xHat += (raw - xHat) * alpha(cfg.minCutoff + cfg.beta * Math.abs(dxHat), dtSec);
			return xHat;
		},
		reset() {
			initialized = false;
		},
	};
}
