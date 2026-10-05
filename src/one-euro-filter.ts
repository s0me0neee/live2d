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
	step(raw: number, deltaMs: number, cfg: OneEuroConfig): number;
	reset(): void;
}

const TWO_PI = 2 * Math.PI;
const alpha = (cutoffHz: number, dtSec: number): number => 1 / (1 + 1 / (TWO_PI * cutoffHz) / dtSec);

// The caller (rig.ts) only ever calls step() when a channel is actually driving
// output, so raw values can go a long time between calls (e.g. face tracking regained
// after minutes away). `msSinceChange` — not the render tick's own deltaMs — is what
// the velocity estimate is computed against, so a stale gap can't be mistaken for slow
// motion; see rig.ts's reset-on-liveness-change for the complementary half of this.
export function createOneEuroFilter(): OneEuroFilter {
	let xPrev = 0;
	let xHat = 0;
	let dxHat = 0;
	let cutoff = 1;
	let msSinceChange = 0;
	let initialized = false;

	return {
		step(raw, deltaMs, cfg) {
			if (!initialized) {
				xPrev = raw;
				xHat = raw;
				dxHat = 0;
				cutoff = cfg.minCutoff;
				msSinceChange = 0;
				initialized = true;
				return xHat;
			}

			msSinceChange += deltaMs;
			if (raw !== xPrev) {
				// Floored so a same-tick raw change (deltaMs can legitimately be 0) can't divide
				// by zero and poison dxHat/cutoff with Infinity/NaN forever.
				const dtSec = Math.max(msSinceChange, 1) / 1000;
				const dx = (raw - xPrev) / dtSec;
				dxHat += (dx - dxHat) * alpha(cfg.dCutoff, dtSec);
				cutoff = cfg.minCutoff + cfg.beta * Math.abs(dxHat);
				xPrev = raw;
				msSinceChange = 0;
			}

			xHat += (raw - xHat) * alpha(cutoff, deltaMs / 1000);
			return xHat;
		},
		reset() {
			initialized = false;
		},
	};
}
