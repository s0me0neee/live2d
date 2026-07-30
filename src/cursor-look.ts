import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config } from "./config";
import { clamp, type LookTarget } from "./rig";

// Make the model watch the mouse, from either of two sources: pointer events while the
// overlay is clickable, and — while it's click-through, when Wayland stops delivering
// them entirely — the global cursor position main polls off the compositor. The two
// never overlap, so both feed the same mapping.
//
// Only aims the shared look target; rig.ts owns the clamping, smoothing, body-follow and
// parameter writing, so a cursor-driven head moves through exactly the same pipeline as a
// webcam-driven one. The rig applies this only while face tracking has nothing to say.
//
// The handlers just record the raw position and a ticker callback filters it, rather than
// filtering in the handlers: both input sources go silent once the mouse stops moving
// (main skips unchanged poll samples), so a per-event filter would freeze partway through
// a move and never reach the target — and its rate would vary with mouse speed.
//
// Hyprland-only: main answers `supported` false everywhere else, and never sends a
// position. Off elsewhere rather than half-working, since the click-through case is the
// whole point and no other compositor can serve it.
export async function setupCursorLook(
	look: LookTarget,
	app: PIXI.Application,
	model: Live2DModel,
	config: Config,
): Promise<void> {
	const { enabled, range, headDeg, eyeGain, lagMs } = config.cursorLook;
	const api = window.electronAPI;
	if (!enabled || !api || !(await api.cursorLook.supported())) return;

	const lookAt = (x: number, y: number): void => {
		// Distance for a full turn scales with the model, so zooming doesn't change how
		// far the mouse must travel. Screen y grows downward, head pitch upward.
		const radius = Math.max(1, model.height * 0.5 * range);
		const nx = clamp((x - model.x) / radius, -1, 1);
		const ny = clamp((model.y - y) / radius, -1, 1);

		look.angleX = nx * headDeg;
		look.angleY = ny * headDeg;
		// Cross-term tilt, the shape the Cubism runtime's own focus controller used — a
		// diagonal glance rolls the head slightly, straight-on movement doesn't.
		look.angleZ = -nx * ny * headDeg;
		// eyeGain > 1 saturates the eyes before the head finishes turning, so a small
		// glance moves only the eyes.
		look.eyeBallX = nx * eyeGain;
		look.eyeBallY = ny * eyeGain;
	};

	let rawX = 0;
	let rawY = 0;
	let smoothX = 0;
	let smoothY = 0;
	let seen = false;

	const onCursor = (x: number, y: number): void => {
		rawX = x;
		rawY = y;
		// The first sample snaps: easing from the initial 0,0 would sweep the head in from
		// the window's top-left corner on startup.
		if (!seen) {
			smoothX = x;
			smoothY = y;
			seen = true;
		}
	};

	app.stage.on("globalpointermove", (e: PIXI.FederatedPointerEvent) =>
		onCursor(e.global.x, e.global.y),
	);
	api.cursorLook.onPos((p) => onCursor(p.x, p.y));

	app.ticker.add(() => {
		if (!seen) return; // no cursor seen yet — leave the model facing forward
		// A time constant rather than a per-frame factor, so the feel doesn't change with
		// renderFps. Clamped because lagMs <= 0 would otherwise overshoot or run away.
		const k = clamp(1 - Math.exp(-app.ticker.deltaMS / lagMs), 0, 1);
		smoothX += (rawX - smoothX) * k;
		smoothY += (rawY - smoothY) * k;
		lookAt(smoothX, smoothY);
	});
}
