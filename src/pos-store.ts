import type { Pos } from "./config";

let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced write of the live transform into the model's TOML so a drag/zoom
 * flurry hits disk once. No-op in plain-browser dev (no electronAPI).
 */
export function savePos(pos: Pos, debounceMs = 400): void {
	const api = window.electronAPI;
	if (!api) return;
	clearTimeout(timer);
	timer = setTimeout(() => {
		api.savePos(pos).catch((e) => console.warn("savePos failed:", e));
	}, debounceMs);
}
