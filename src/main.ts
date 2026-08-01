import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { DEFAULT_CONFIG, DEFAULT_MODEL_CONFIG, type ResolvedConfig } from "./config";
import { startFaceTracking } from "./face-tracking";
import { setupExpressions } from "./expressions";
import { setupPhysics } from "./physics";
import { setupInteraction } from "./interaction";
import { setupCursorLook } from "./cursor-look";
import { createRigDriver, type RigDriver } from "./rig";
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
	antialias: false,
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

	// Cubism's clip-mask capacity is 36 with a single render texture; models with more
	// distinct clip-mask groups than that fall back every frame to cramming all masks
	// into one shared buffer/channel, which is both visually wrong and a perf sink.
	// pixi-live2d-display always initializes with maskBufferCount=1, so bump it here.
	const internal = model.internalModel as any;
	internal.renderer.initialize(internal.coreModel, 2);

	app.stage.addChild(model);
	model.anchor.set(0.5, 0.5);
	// First load: centered at scale 1. setupInteraction restores [pos] if present.
	model.position.set(app.screen.width / 2, app.screen.height / 2);
	model.scale.set(1);

	globalThis.__model = model; // pokeable from devtools

	// The runtime's built-in mouse-follow writes the head params directly, ignoring the
	// model's physics-aware headAngle ids and every tuning knob. cursor-look.ts feeds the
	// rig instead, so this stays off; off here rather than in a feature module so it's
	// off even when that one bails out.
	(model as any).automator.autoFocus = false;

	setupPhysics(model, config);
	setupInteraction(app, model, modelConfig);

	// Owns all parameter writing, and runs whether or not the sources below start, so a
	// machine with no camera still gets clamping, smoothing and body-follow. Guarded like
	// the async setups below: an unexpected model/runtime shape shouldn't crash boot.
	let rig: RigDriver | undefined;
	try {
		rig = createRigDriver(model, config, modelConfig);
	} catch (err) {
		console.warn("Rig driver failed to initialize — face tracking and cursor look disabled:", err);
	}

	if (rig) {
		startFaceTracking(rig, config).catch((err) =>
			console.warn("Face tracking disabled:", err),
		);
		setupCursorLook(rig.look, app, model, config).catch((err) =>
			console.warn("Cursor look disabled:", err),
		);
	}
	setupExpressions(model, modelConfig, config.showExpressions).catch((err) =>
		console.warn("Expressions disabled:", err),
	);
}
