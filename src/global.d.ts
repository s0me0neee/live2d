import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";

declare global {
	interface Window {
		PIXI: typeof PIXI;
		electronAPI?: {
			loadPos(): Promise<{ x: number; y: number; scale: number } | null>;
			savePos(pos: { x: number; y: number; scale: number }): Promise<void>;
			setOverlayMode(mode: "off" | "auto"): void;
			reportHitRegion(
				rect: { x: number; y: number; width: number; height: number } | null,
			): void;
		};
	}
	// eslint-disable-next-line no-var
	var __model: Live2DModel;
}

export {};
