import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config } from "./config";

// Tunes the breath sway and the hair/cloth pendulum sim by mutating private
// Cubism runtime fields. Guarded so a runtime shape change can't break boot.
export function setupPhysics(model: Live2DModel, config: Config): void {
	const internal = model.internalModel as any;

	const breath: number = config.breath;
	if (breath === 0) {
		internal.breath = undefined; // updateNaturalMovements guards with ?.
	} else if (breath !== 1) {
		for (const data of internal.breath?._breathParameters ?? []) {
			data.peak *= breath;
		}
	}

	const physics = internal.physics;
	if (!physics) return;
	const p = config.physics;

	const springiness: number = p.springiness;
	if (springiness !== 1) {
		for (const particle of physics._physicsRig?.particles ?? []) {
			particle.mobility *= springiness;
		}
	}

	if (!p.windEnabled) return;
	const wind = physics.getOption?.().wind;
	if (!wind) return;
	wind.x = p.wind.x;
	wind.y = p.wind.y;

	const gust: number = p.gust;
	if (gust !== 0) {
		const start = performance.now();
		const animate = () => {
			const t = (performance.now() - start) / 1000;
			wind.x = p.wind.x + Math.sin(t * p.gustHz * Math.PI * 2) * gust;
			requestAnimationFrame(animate);
		};
		requestAnimationFrame(animate);
	}
}
