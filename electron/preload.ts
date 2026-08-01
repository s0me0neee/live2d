import { contextBridge, ipcRenderer } from "electron";
import type { HotkeyId, Pos, ResolvedConfig } from "../src/config";
import type { FaceResult } from "../src/face-worker";
import { IS_WAYLAND } from "./platform";

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

contextBridge.exposeInMainWorld("electronAPI", {
	// The host OS. isWayland flags the one thing Linux itself doesn't determine — the
	// renderer's move/resize guide is off on Wayland (can't self-position) but on for
	// macOS, Windows and X11 Linux alike.
	platform: process.platform,
	isWayland: IS_WAYLAND,
	// Resolved TOML config, fetched once at boot.
	getConfig: (): Promise<ResolvedConfig> => ipcRenderer.invoke("config:get"),
	// Report the live transform to main (held in memory, written to the model TOML
	// only at quit). Fire-and-forget so dragging isn't gated on IPC round-trips.
	reportPos: (pos: Pos): void => ipcRenderer.send("pos:report", pos),
	setExpression: (name: string, active: boolean): Promise<void> =>
		ipcRenderer.invoke("config:set-expression", name, active),

	// Overlay click-through control (≈ Tauri overlay_set_lock). `locked` = the
	// overlay passes mouse events through to whatever is underneath.
	overlay: {
		setLock: (locked: boolean): Promise<void> =>
			ipcRenderer.invoke("overlay:set-lock", locked),
		getLock: (): Promise<boolean> => ipcRenderer.invoke("overlay:get-lock"),
		toggleLock: (): Promise<boolean> => ipcRenderer.invoke("overlay:toggle-lock"),
		// Fires when the lock changes (e.g. via the global hotkey). Returns an
		// unsubscribe function.
		onLockChanged: (cb: (locked: boolean) => void): (() => void) => {
			const listener = (_e: unknown, locked: boolean) => cb(locked);
			ipcRenderer.on("overlay:lock-changed", listener);
			return () => ipcRenderer.removeListener("overlay:lock-changed", listener);
		},
	},

	// Move/resize the OS overlay window itself (driven by the in-app guide shown
	// when unlocked). getBounds is awaited at drag start; setBounds is fire-and-
	// forget so a fast drag isn't gated on IPC round-trips.
	windowControls: {
		getBounds: (): Promise<Bounds | null> => ipcRenderer.invoke("window:get-bounds"),
		setBounds: (b: Bounds): void => ipcRenderer.send("window:set-bounds", b),
	},

	faceTracking: {
		// Fires when the tray "recenter" item is clicked. Returns an unsubscribe fn.
		onRecenter: (cb: () => void): (() => void) => {
			const listener = () => cb();
			ipcRenderer.on("face:recenter", listener);
			return () => ipcRenderer.removeListener("face:recenter", listener);
		},
	},

	// Relays each detection result to the face-debug window (electron/face-debug-window.ts)
	// when it's open; main.ts no-ops the relay otherwise, so send() is always cheap to call.
	faceDebug: {
		send: (result: FaceResult): void => ipcRenderer.send("face-debug:data", result),
		onData: (cb: (result: FaceResult) => void): (() => void) => {
			const listener = (_e: unknown, result: FaceResult) => cb(result);
			ipcRenderer.on("face-debug:data", listener);
			return () => ipcRenderer.removeListener("face-debug:data", listener);
		},
	},

	// Make the model watch the mouse. `supported` reflects the config toggle — main
	// always has a working global-cursor source (Hyprland native, or Electron's screen
	// API elsewhere). `onPos` fires only while locked, with window-local coordinates;
	// unlocked, the renderer reads the cursor from ordinary pointer events. Returns an
	// unsubscribe fn.
	cursorLook: {
		supported: (): Promise<boolean> => ipcRenderer.invoke("cursor:supported"),
		onPos: (cb: (p: { x: number; y: number }) => void): (() => void) => {
			const listener = (_e: unknown, p: { x: number; y: number }) => cb(p);
			ipcRenderer.on("cursor:pos", listener);
			return () => ipcRenderer.removeListener("cursor:pos", listener);
		},
	},

	// Read / rebind a global accelerator (settings window). "" unbinds it. set()
	// resolves false if a non-empty accelerator is invalid or already taken.
	hotkey: {
		get: (id: HotkeyId): Promise<string> => ipcRenderer.invoke("config:get-hotkey", id),
		set: (id: HotkeyId, accelerator: string): Promise<boolean> =>
			ipcRenderer.invoke("config:set-hotkey", id, accelerator),
	},

	// Live show/hide of the FPS counter and expression list, toggled from the tray.
	// Each returns an unsubscribe function.
	ui: {
		onShowFps: (cb: (visible: boolean) => void): (() => void) =>
			subscribe("ui:show-fps", cb),
		onShowExpressions: (cb: (visible: boolean) => void): (() => void) =>
			subscribe("ui:show-expressions", cb),
	},
});

function subscribe(channel: string, cb: (visible: boolean) => void): () => void {
	const listener = (_e: unknown, visible: boolean) => cb(visible);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}
