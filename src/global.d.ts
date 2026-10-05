import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config, DeepPartial, HotkeyId, Pos, ResolvedConfig } from "./config";
import type { FaceResult } from "./face-worker";

// Mirrors electron/config.ts's UiToggle without importing across the electron/src
// boundary (electron/ isn't part of this project's tsconfig).
type UiToggle = "showFps" | "showExpressions";

declare global {
	interface Window {
		PIXI: typeof PIXI;
		electronAPI?: {
			platform: NodeJS.Platform;
			isWayland: boolean;
			getConfig(): Promise<ResolvedConfig>;
			reportPos(pos: Pos): void;
			// modelName pins the edit to the model it was made against, not whatever's
			// active by the time main handles it (it may be debounced or simply in flight
			// over IPC when the user switches models).
			setExpression(modelName: string, name: string, active: boolean): Promise<void>;
			// The settings window's write surface. Every write also arrives via onChanged,
			// broadcast to both this window and the overlay.
			config: {
				listModels(): Promise<string[]>;
				setModel(name: string): Promise<ResolvedConfig>;
				setGain(modelName: string, name: string, value: number): Promise<ResolvedConfig>;
				update(patch: DeepPartial<Config>): Promise<ResolvedConfig>;
				onChanged(cb: (cfg: ResolvedConfig) => void): () => void;
			};
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
				recenter(): Promise<void>;
			};
			faceDebug: {
				send(result: FaceResult): void;
				onData(cb: (result: FaceResult) => void): () => void;
			};
			// Global cursor position while click-through (src/cursor-look.ts).
			cursorLook: {
				supported(): Promise<boolean>;
				onPos(cb: (p: { x: number; y: number }) => void): () => void;
			};
			hotkey: {
				get(id: HotkeyId): Promise<string>;
				set(id: HotkeyId, accelerator: string): Promise<boolean>;
			};
			ui: {
				onShowFps(cb: (visible: boolean) => void): () => void;
				onShowExpressions(cb: (visible: boolean) => void): () => void;
				set(key: UiToggle, value: boolean): Promise<void>;
			};
		};
	}
	var __model: Live2DModel;

	// Chromium insertable-streams API (video-track flavor); not in TS's DOM lib yet.
	class MediaStreamTrackProcessor {
		constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
		readonly readable: ReadableStream<VideoFrame>;
	}
}

export {};
