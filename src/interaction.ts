import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { loadPos, savePos } from "./pos-store";

// Zoom limits as a multiple of the model's starting scale.
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const WHEEL_SENSITIVITY = 0.001; // higher = faster zoom per scroll tick

/**
 * Lets the user drag the model with the mouse and zoom with the scroll wheel.
 * Drag grabs the model itself (not the empty canvas); zoom is anchored under the
 * cursor so the point you point at stays put.
 */
export async function setupInteraction(app: PIXI.Application, model: Live2DModel): Promise<void> {
	// Capture the configured default BEFORE restoring, so zoom limits stay
	// relative to model-config's scale, not whatever was last saved.
	const baseScale = model.scale.x;
	const min = baseScale * MIN_ZOOM;
	const max = baseScale * MAX_ZOOM;

	const clampScale = (s: number) => Math.min(max, Math.max(min, s));
	const persist = () => savePos({ x: model.x, y: model.y, scale: model.scale.x });

	// restore the last drag/zoom from pos.toml (no-op in plain-browser dev)
	const saved = await loadPos();
	if (saved) {
		model.position.set(saved.x, saved.y);
		model.scale.set(clampScale(saved.scale));
	}

	// --- drag ---
	model.eventMode = "static";
	model.cursor = "grab";

	let dragging = false;
	let offsetX = 0;
	let offsetY = 0;

	model.on("pointerdown", (e: PIXI.FederatedPointerEvent) => {
		dragging = true;
		offsetX = model.x - e.global.x;
		offsetY = model.y - e.global.y;
		model.cursor = "grabbing";
	});

	// Listen on the stage so the model keeps following even if the pointer
	// briefly outruns it during a fast drag.
	app.stage.eventMode = "static";
	app.stage.hitArea = app.screen;
	app.stage.on("pointermove", (e: PIXI.FederatedPointerEvent) => {
		if (dragging) model.position.set(e.global.x + offsetX, e.global.y + offsetY);
	});

	const stop = () => {
		if (!dragging) return;
		dragging = false;
		model.cursor = "grab";
		persist();
	};
	app.stage.on("pointerup", stop);
	app.stage.on("pointerupoutside", stop);

	// --- zoom (toward the cursor) ---
	const view = app.view as HTMLCanvasElement;
	view.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			e.preventDefault();
			const prev = model.scale.x;
			const next = clampScale(prev * Math.exp(-e.deltaY * WHEEL_SENSITIVITY));
			if (next === prev) return;
			// keep the model point under the cursor fixed while scaling
			const k = next / prev;
			model.position.set(
				e.offsetX + (model.x - e.offsetX) * k,
				e.offsetY + (model.y - e.offsetY) * k,
			);
			model.scale.set(next);
			persist();
		},
		{ passive: false },
	);
}
