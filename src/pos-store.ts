export interface Pos {
	x: number;
	y: number;
	scale: number;
}

// Exposed by electron/preload.ts via contextBridge. Absent in plain-browser dev
// (e.g. `vite` without Electron), where persistence becomes a no-op.
interface ElectronAPI {
	loadPos(): Promise<Pos | null>;
	savePos(pos: Pos): Promise<void>;
}
const api: ElectronAPI | undefined = (window as unknown as { electronAPI?: ElectronAPI })
	.electronAPI;

/** Reads pos.toml via the main process; null on first launch / not in Electron. */
export async function loadPos(): Promise<Pos | null> {
	if (!api) return null;
	try {
		return (await api.loadPos()) ?? null;
	} catch (e) {
		console.warn("load_pos failed:", e);
		return null;
	}
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced write to pos.toml so a drag/zoom flurry hits disk once. */
export function savePos(pos: Pos, debounceMs = 400): void {
	if (!api) return;
	clearTimeout(timer);
	timer = setTimeout(() => {
		api.savePos(pos).catch((e) => console.warn("save_pos failed:", e));
	}, debounceMs);
}
