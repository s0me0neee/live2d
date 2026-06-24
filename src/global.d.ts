import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";

declare global {
	interface Window {
		PIXI: typeof PIXI;
	}
	// eslint-disable-next-line no-var
	var __model: Live2DModel;
}

export {};
