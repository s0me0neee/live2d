import { contextBridge, ipcRenderer } from "electron";
import type { Pos, ResolvedConfig } from "../src/config";

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

contextBridge.exposeInMainWorld("electronAPI", {
	// Resolved TOML config, fetched once at boot.
	getConfig: (): Promise<ResolvedConfig> => ipcRenderer.invoke("config:get"),
	// Persist the live transform / an expression toggle into the model's TOML.
	savePos: (pos: Pos): Promise<void> => ipcRenderer.invoke("config:save-pos", pos),
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

	// Read / rebind the global lock-toggle accelerator (settings window). set()
	// resolves false if the accelerator is invalid or already taken.
	hotkey: {
		get: (): Promise<string> => ipcRenderer.invoke("config:get-hotkey"),
		set: (accelerator: string): Promise<boolean> =>
			ipcRenderer.invoke("config:set-hotkey", accelerator),
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
