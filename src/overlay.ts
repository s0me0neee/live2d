import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { config } from "./config";

/**
 * Click-through overlay ("auto" mode): the window passes mouse clicks through to
 * whatever is behind it, EXCEPT when the cursor is over the model. We can't
 * hit-test in the renderer while click-through is active (Electron only forwards
 * mouse events on Win/macOS, not Linux), so we stream the model's window-relative
 * bounding box to the main process, which polls the global cursor against it.
 *
 * No-op outside Electron (plain `vite` dev) or when clickThrough is "off".
 */
export function setupClickThrough(model: Live2DModel): void {
	const api = window.electronAPI;
	if (!api?.setOverlayMode) return;

	if (config.clickThrough !== "auto") {
		api.setOverlayMode("off");
		return;
	}
	api.setOverlayMode("auto");

	// model.getBounds() is in stage units, which equal CSS pixels here
	// (autoDensity), matching the window's content bounds on the main side.
	let last = "";
	const report = (): void => {
		const b = model.getBounds();
		const key = `${b.x | 0},${b.y | 0},${b.width | 0},${b.height | 0}`;
		if (key === last) return; // only send when the box actually moves/resizes
		last = key;
		api.reportHitRegion?.({ x: b.x, y: b.y, width: b.width, height: b.height });
	};

	report();
	// The model sways/drifts continuously; a few updates/sec keeps the hit box
	// fresh without flooding IPC (the cursor poll on main runs at ~60 Hz).
	setInterval(report, 100);
}
