import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { config } from "./config";
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
	clearBeforeRender: true, // wipe the canvas each frame so a moving model leaves no trail
	resolution: window.devicePixelRatio || 1, // native pixel density (sharp on Retina)
	autoDensity: true, // keep CSS size correct while the backing store scales up
	antialias: true,
});

// Optional frame cap. The Electron overlay disables vsync, so without this the
// render loop runs unbounded (200+ fps). maxFPS = 0 is Pixi's "uncapped"; cap
// both the app's render ticker and the shared ticker (which pixi-live2d-display
// uses to update the model) so the limit covers drawing AND model updates.
app.ticker.maxFPS = config.renderFps;
PIXI.Ticker.shared.maxFPS = config.renderFps;

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
