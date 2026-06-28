import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { ModelConfig } from "./config";
import { reportPos } from "./pos-store";

const MIN_SCALE = 0.05;
const MAX_SCALE = 5;
const WHEEL_SENSITIVITY = 0.001; // higher = faster zoom per scroll tick

// Drag the model (not the canvas) and scroll-zoom toward the cursor. The live
// transform is restored from, and persisted back into, the model's TOML [pos].
export function setupInteraction(
	app: PIXI.Application,
	model: Live2DModel,
	modelConfig: ModelConfig,
): void {
	const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
	const report = () => reportPos({ x: model.x, y: model.y, scale: model.scale.x });

	const saved = modelConfig.pos;
	if (saved) {
		model.position.set(saved.x, saved.y);
		model.scale.set(clampScale(saved.scale));
	}

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

	// On the stage so the model keeps following if the pointer outruns it.
	app.stage.eventMode = "static";
	app.stage.hitArea = app.screen;
	app.stage.on("pointermove", (e: PIXI.FederatedPointerEvent) => {
		if (dragging) model.position.set(e.global.x + offsetX, e.global.y + offsetY);
	});

	const stop = () => {
		if (!dragging) return;
		dragging = false;
		model.cursor = "grab";
		report();
	};
	app.stage.on("pointerup", stop);
	app.stage.on("pointerupoutside", stop);

	const view = app.view as HTMLCanvasElement;
	view.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			e.preventDefault();
			const prev = model.scale.x;
			const next = clampScale(prev * Math.exp(-e.deltaY * WHEEL_SENSITIVITY));
			if (next === prev) return;
			// Keep the point under the cursor fixed while scaling.
			const k = next / prev;
			model.position.set(
				e.offsetX + (model.x - e.offsetX) * k,
				e.offsetY + (model.y - e.offsetY) * k,
			);
			model.scale.set(next);
			report();
		},
		{ passive: false },
	);
}
