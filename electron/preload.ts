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
});
