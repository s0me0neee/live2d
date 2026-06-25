import { invoke } from "@tauri-apps/api/core";

export interface Pos {
	x: number;
	y: number;
	scale: number;
}

// Only the Tauri build can touch the filesystem; in plain-browser dev these
// become no-ops (load returns null, save does nothing).
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Reads pos.toml via the Rust command; null on first launch / not in Tauri. */
export async function loadPos(): Promise<Pos | null> {
	if (!inTauri) return null;
	try {
		return (await invoke<Pos | null>("load_pos")) ?? null;
	} catch (e) {
		console.warn("load_pos failed:", e);
		return null;
	}
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced write to pos.toml so a drag/zoom flurry hits disk once. */
export function savePos(pos: Pos, debounceMs = 400): void {
	if (!inTauri) return;
	clearTimeout(timer);
	timer = setTimeout(() => {
		invoke("save_pos", { pos }).catch((e) => console.warn("save_pos failed:", e));
	}, debounceMs);
}
