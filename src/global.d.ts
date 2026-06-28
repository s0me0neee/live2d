import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { HotkeyId, Pos, ResolvedConfig } from "./config";

declare global {
	interface Window {
		PIXI: typeof PIXI;
		electronAPI?: {
			getConfig(): Promise<ResolvedConfig>;
			reportPos(pos: Pos): void;
			setExpression(name: string, active: boolean): Promise<void>;
			overlay: {
				setLock(locked: boolean): Promise<void>;
				getLock(): Promise<boolean>;
				toggleLock(): Promise<boolean>;
				onLockChanged(cb: (locked: boolean) => void): () => void;
			};
			// Move/resize the OS overlay window (driven by src/window-controls.ts).
			windowControls: {
				getBounds(): Promise<{
					x: number;
					y: number;
					width: number;
					height: number;
				} | null>;
				setBounds(b: { x: number; y: number; width: number; height: number }): void;
			};
			faceTracking: {
				onRecenter(cb: () => void): () => void;
			};
			hotkey: {
				get(id: HotkeyId): Promise<string>;
				set(id: HotkeyId, accelerator: string): Promise<boolean>;
			};
			ui: {
				onShowFps(cb: (visible: boolean) => void): () => void;
				onShowExpressions(cb: (visible: boolean) => void): () => void;
			};
		};
	}
	// eslint-disable-next-line no-var
	var __model: Live2DModel;
}

export {};
