import { contextBridge, ipcRenderer } from "electron";

export interface Pos {
	x: number;
	y: number;
	scale: number;
}

// Bridge the position-persistence IPC into the sandboxed renderer. Mirrors the
// old Tauri `load_pos` / `save_pos` commands.
contextBridge.exposeInMainWorld("electronAPI", {
	loadPos: (): Promise<Pos | null> => ipcRenderer.invoke("load-pos"),
	savePos: (pos: Pos): Promise<void> => ipcRenderer.invoke("save-pos", pos),

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
});
