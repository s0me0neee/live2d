import type * as PIXI from "pixi.js";

export function mountFps(app: PIXI.Application): void {
	const el = document.getElementById("fps");
	if (!el) return;

	let sinceRefresh = 0;
	app.ticker.add(() => {
		sinceRefresh += app.ticker.deltaMS;
		if (sinceRefresh >= 250) {
			el.textContent = `${Math.round(app.ticker.FPS)} FPS`;
			sinceRefresh = 0;
		}
	});
}
