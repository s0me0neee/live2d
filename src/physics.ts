import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { config } from "./config";

/**
 * Tunes the model's pendulum physics (the hair/cloth sim) from config.physics:
 *  - springiness: scales every strand's mobility (velocity retention => bounce)
 *  - wind: a steady breeze added to every strand, optionally gusting
 *
 * These change the simulation itself, unlike hair/clothesGain which just scale
 * the resulting amplitude. Reaches into the Cubism runtime's private fields
 * (same style as face-tracking.ts); guarded so a shape change can't break boot.
 */
export function setupPhysics(model: Live2DModel): void {
	const internal = (model.internalModel as any);

	// breath: scale the idle sine (head sway + ParamBreath). 0 kills it entirely.
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

	// springiness: higher mobility => velocity carries further => more overshoot
	const springiness: number = p.springiness;
	if (springiness !== 1) {
		for (const particle of physics._physicsRig?.particles ?? []) {
			particle.mobility *= springiness;
		}
	}

	// wind: evaluate() reads these live each frame, so the gust loop takes effect
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
