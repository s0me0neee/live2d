import * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config } from "./config";

export interface PhysicsHandle {
	// Re-applies breath/springiness from their captured baselines and the latest config.
	// Idempotent (unlike the old *= in place), so the settings window can call it as
	// often as it likes without the scaling compounding.
	apply(config: Config): void;
}

// Tunes the breath sway and the hair/cloth pendulum sim by mutating private Cubism
// runtime fields. Guarded so a runtime shape change can't break boot.
export function setupPhysics(model: Live2DModel, config: Config): PhysicsHandle {
	const internal = model.internalModel as any;

	// Captured once so `apply` can scale from the model's authored values instead of the
	// previous call's already-scaled ones.
	const originalBreath = internal.breath;
	const breathBaseline: number[] = (originalBreath?._breathParameters ?? []).map(
		(d: any) => d.peak,
	);

	const physics = internal.physics;
	const springBaseline: number[] = (physics?._physicsRig?.particles ?? []).map(
		(p: any) => p.mobility,
	);

	function apply(cfg: Config): void {
		const breath = cfg.breath;
		if (breath === 0) {
			internal.breath = undefined; // updateNaturalMovements guards with ?.
		} else {
			internal.breath = originalBreath;
			(originalBreath?._breathParameters ?? []).forEach((d: any, i: number) => {
				d.peak = breathBaseline[i] * breath;
			});
		}

		if (physics) {
			(physics._physicsRig?.particles ?? []).forEach((particle: any, i: number) => {
				particle.mobility = springBaseline[i] * cfg.physics.springiness;
			});
		}
	}

	apply(config);

	// Wind + gust read config.physics fresh every tick (rather than being captured once),
	// so windEnabled/wind/gust/gustHz are live-editable from the settings window with no
	// separate re-apply plumbing. `wind` itself is fetched once — getOption() returns the
	// runtime's live options object, not a snapshot, so there's no need to re-fetch it per
	// frame. Driven by the shared ticker (not a raw rAF loop) so it respects the renderFps
	// cap main.ts applies everywhere else.
	const wind = physics?.getOption?.().wind;
	if (wind) {
		const start = performance.now();
		PIXI.Ticker.shared.add(() => {
			const p = config.physics;
			if (!p.windEnabled) {
				wind.x = 0;
				wind.y = 0;
				return;
			}
			const t = (performance.now() - start) / 1000;
			wind.x = p.wind.x + (p.gust !== 0 ? Math.sin(t * p.gustHz * Math.PI * 2) * p.gust : 0);
			wind.y = p.wind.y;
		});
	}

	return { apply };
}
