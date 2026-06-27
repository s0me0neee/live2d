import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";

declare global {
	interface Window {
		PIXI: typeof PIXI;
		electronAPI?: {
			loadPos(): Promise<{ x: number; y: number; scale: number } | null>;
			savePos(pos: { x: number; y: number; scale: number }): Promise<void>;
			overlay: {
				setLock(locked: boolean): Promise<void>;
				getLock(): Promise<boolean>;
				toggleLock(): Promise<boolean>;
				onLockChanged(cb: (locked: boolean) => void): () => void;
			};
			// Linux click-through API (cursor-poll hit-test). Dormant on macOS —
			// the macOS build doesn't expose these, so src/overlay.ts feature-detects
			// them and no-ops. Declared optional so both code paths type-check until
			// the Linux branch is merged. See electron/mac-overlay.ts for macOS.
			setOverlayMode?(mode: "off" | "auto"): void;
			reportHitRegion?(
				rect: { x: number; y: number; width: number; height: number } | null,
			): void;
		};
	}
	// eslint-disable-next-line no-var
	var __model: Live2DModel;
}

export {};
