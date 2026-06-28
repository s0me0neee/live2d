import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { DEFAULT_CONFIG, DEFAULT_MODEL_CONFIG, type ResolvedConfig } from "./config";
import { startFaceTracking } from "./face-tracking";
import { setupExpressions } from "./expressions";
import { setupPhysics } from "./physics";
import { setupInteraction } from "./interaction";
import { setupWindowControls } from "./window-controls";
import { mountFps } from "./fps";
import { modelAssetUrl } from "./model-url";

// pixi-live2d-display reads window.PIXI to auto-register its ticker/interaction.
window.PIXI = PIXI;

// In plain-browser dev there's no electronAPI; the fallback config has no model.
const api = window.electronAPI;
const { config, model: modelConfig }: ResolvedConfig = api
	? await api.getConfig()
	: { modelName: "", config: DEFAULT_CONFIG, model: { ...DEFAULT_MODEL_CONFIG, expressions: {} } };

const app = new PIXI.Application({
	view: document.getElementById("live2d") as HTMLCanvasElement,
	resizeTo: window,
	backgroundAlpha: 0,
	clearBeforeRender: true, // else a moving model leaves a trail
	resolution: window.devicePixelRatio || 1, // sharp on Retina
	autoDensity: true,
	antialias: true,
});

// The overlay disables vsync, so cap the framerate. Both the render ticker and the
// shared ticker (which updates the model) need the cap.
app.ticker.maxFPS = config.renderFps;
PIXI.Ticker.shared.maxFPS = config.renderFps;

// "llvmpipe"/"softpipe"/"SwiftShader" means we're on the CPU (slow), not the GPU.
{
	const gl = (app.renderer as PIXI.Renderer).gl;
	const dbg = gl.getExtension("WEBGL_debug_renderer_info");
	console.log("WebGL renderer:", dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "(masked)");
}

mountFps(app, config.showFps);
setupWindowControls();

if (!modelConfig.location || !modelConfig.model) {
	console.warn("No model configured — set location/model in the model's TOML.");
} else {
	const base = modelConfig.resolvedLocation || modelConfig.location;
	const model = await Live2DModel.from(modelAssetUrl(base, modelConfig.model));
	app.stage.addChild(model);
	model.anchor.set(0.5, 0.5);
	// First load: centered at scale 1. setupInteraction restores [pos] if present.
	model.position.set(app.screen.width / 2, app.screen.height / 2);
	model.scale.set(1);

	globalThis.__model = model; // pokeable from devtools

	setupPhysics(model, config);
	setupInteraction(app, model, modelConfig);

	// Guarded so the app survives camera denial / missing expression assets.
	startFaceTracking(model, config, modelConfig).catch((err) =>
		console.warn("Face tracking disabled:", err),
	);
	setupExpressions(model, modelConfig, config.showExpressions).catch((err) =>
		console.warn("Expressions disabled:", err),
	);
}
