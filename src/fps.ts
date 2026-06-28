import type * as PIXI from "pixi.js";

export function mountFps(app: PIXI.Application, visible: boolean): void {
	const el = document.getElementById("fps");
	if (!el) return;

	const setVisible = (v: boolean) => {
		el.style.display = v ? "" : "none";
	};
	setVisible(visible);
	window.electronAPI?.ui?.onShowFps(setVisible);

	let sinceRefresh = 0;
	app.ticker.add(() => {
		sinceRefresh += app.ticker.deltaMS;
		if (sinceRefresh >= 250) {
			el.textContent = `${Math.round(app.ticker.FPS)} FPS`;
			sinceRefresh = 0;
		}
	});
}
