import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { startFaceTracking } from "./face-tracking";

// expose PIXI so pixi-live2d-display can auto-register its ticker/interaction
window.PIXI = PIXI;

const app = new PIXI.Application({
	view: document.getElementById("live2d") as HTMLCanvasElement,
	resizeTo: window,
	backgroundAlpha: 0, // transparent canvas (handy for an overlay window later)
	resolution: window.devicePixelRatio || 1, // render at native pixel density (sharp on Retina/HiDPI)
	autoDensity: true, // keep CSS size correct while backing store is scaled up
	antialias: true,
});

const model = await Live2DModel.from("/model/ariu/ariu.model3.json");
app.stage.addChild(model);

model.anchor.set(0.5, 0.5);
model.position.set(app.screen.width / 2, app.screen.height / 2);
model.scale.set(0.2);

globalThis.__model = model;

// webcam face tracking — keep running even if the camera is denied/unavailable
startFaceTracking(model).catch((err) => {
	console.warn("Face tracking disabled:", err);
});

const fpsEl = document.getElementById("fps")!;

let acc = 0;
app.ticker.add(() => {
	acc += app.ticker.deltaMS;
	if (acc >= 250) {
		fpsEl.textContent = `${Math.round(app.ticker.FPS)} FPS`;
		acc = 0;
	}
});
