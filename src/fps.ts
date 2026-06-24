import type * as PIXI from "pixi.js";

/**
 * Drives the #fps overlay (markup in index.html, styled in styles.css) from the
 * Pixi ticker. Refreshes a few times a second so the number stays legible.
 */
export function mountFps(app: PIXI.Application): void {
	const el = document.getElementById("fps");
	if (!el) return;

	let acc = 0;
	app.ticker.add(() => {
		acc += app.ticker.deltaMS;
		if (acc >= 250) {
			el.textContent = `${Math.round(app.ticker.FPS)} FPS`;
			acc = 0;
		}
	});
}
