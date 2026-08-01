import { app, type BrowserWindow } from "electron";

// The app runs as an accessory (LSUIElement), so steal activation to make the window
// key — otherwise a newly shown window can't receive keystrokes/clicks.
export function focusWindow(win: BrowserWindow): void {
	if (process.platform === "darwin") app.focus({ steal: true });
	win.show();
	win.focus();
}
