import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { modelConfig } from "./model-config";
import { startFaceTracking } from "./face-tracking";
import { setupExpressions } from "./expressions";
import { setupPhysics } from "./physics";
import { setupInteraction } from "./interaction";
import { mountFps } from "./fps";

// expose PIXI so pixi-live2d-display can auto-register its ticker/interaction
window.PIXI = PIXI;

const app = new PIXI.Application({
	view: document.getElementById("live2d") as HTMLCanvasElement,
	resizeTo: window,
	backgroundAlpha: 0, // transparent canvas (handy for an overlay window later)
	resolution: window.devicePixelRatio || 1, // native pixel density (sharp on Retina)
	autoDensity: true, // keep CSS size correct while the backing store scales up
	antialias: true,
});

// Log which GPU the WebGL context landed on. "llvmpipe"/"softpipe"/"SwiftShader"
// here means we're rendering on the CPU (slow); we want the NVIDIA renderer.
{
	const gl = (app.renderer as PIXI.Renderer).gl;
	const dbg = gl.getExtension("WEBGL_debug_renderer_info");
	console.log("WebGL renderer:", dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "(masked)");
}

const model = await Live2DModel.from(modelConfig.dir + modelConfig.file);
app.stage.addChild(model);
model.anchor.set(0.5, 0.5);
model.position.set(app.screen.width / 2, app.screen.height / 2);
model.scale.set(modelConfig.scale);

globalThis.__model = model; // pokeable from the webview devtools

mountFps(app);
setupPhysics(model);
await setupInteraction(app, model);

// Both features keep the app running if they fail (e.g. camera denied).
startFaceTracking(model).catch((err) => console.warn("Face tracking disabled:", err));
setupExpressions(model).catch((err) => console.warn("Expressions disabled:", err));
