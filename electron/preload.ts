import { contextBridge, ipcRenderer } from "electron";

export interface Pos {
	x: number;
	y: number;
	scale: number;
}

// Bridge the position-persistence IPC into the sandboxed renderer. Mirrors the
// old Tauri `load_pos` / `save_pos` commands.
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

contextBridge.exposeInMainWorld("electronAPI", {
	loadPos: (): Promise<Pos | null> => ipcRenderer.invoke("load-pos"),
	savePos: (pos: Pos): Promise<void> => ipcRenderer.invoke("save-pos", pos),

	// Overlay click-through: tell main which mode to run, and stream the model's
	// current window-relative bounds so main can hit-test the cursor against it.
	setOverlayMode: (mode: "off" | "auto"): void =>
		ipcRenderer.send("overlay:set-mode", mode),
	reportHitRegion: (rect: Rect | null): void =>
		ipcRenderer.send("overlay:hit-region", rect),
});
