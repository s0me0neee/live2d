import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { forwardConsole } from "./forward-console";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// Single instance: reopening focuses the existing window instead of stacking.
let settingsWin: BrowserWindow | null = null;

export function openSettings(): void {
	if (settingsWin && !settingsWin.isDestroyed()) {
		focus(settingsWin);
		return;
	}

	// A plain, focusable window — unlike the overlay it must take keyboard focus to
	// capture a shortcut, so it gets no applyMacOverlay treatment.
	const win = new BrowserWindow({
		width: 440,
		height: 220,
		title: "web2d settings",
		resizable: false,
		fullscreenable: false,
		minimizable: false,
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	settingsWin = win;
	forwardConsole(win.webContents, "settings");
	win.on("closed", () => {
		settingsWin = null;
	});
	win.once("ready-to-show", () => focus(win));

	if (DEV_URL) {
		win.loadURL(`${DEV_URL}/settings.html`);
	} else {
		win.loadFile(join(__dirname, "../dist/settings.html"));
	}
}

// The app runs as an accessory (LSUIElement), so steal activation to make the
// window key — otherwise its inputs can't receive the keystrokes to capture.
function focus(win: BrowserWindow): void {
	if (process.platform === "darwin") app.focus({ steal: true });
	win.show();
	win.focus();
}
