import type { Pos } from "./config";

// Report the live transform to the main process. It's kept in memory there and
// written to the model TOML only at quit, so dragging causes no disk writes. No-op
// without electronAPI.
export function reportPos(pos: Pos): void {
	window.electronAPI?.reportPos(pos);
}
