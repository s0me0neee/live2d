import { BrowserWindow } from "electron";
import { join } from "node:path";
import { forwardConsole } from "./forward-console";
import { createLogger } from "./log";
import { focusWindow } from "./window-utils";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const log = createLogger("settings");

// Single instance: reopening focuses the existing window instead of stacking.
let settingsWin: BrowserWindow | null = null;

export function openSettings(): void {
	if (settingsWin && !settingsWin.isDestroyed()) {
		focusWindow(settingsWin);
		return;
	}

	// A plain, focusable window — unlike the overlay it must take keyboard focus to
	// capture a shortcut, so it gets no applyMacOverlay treatment.
	const win = new BrowserWindow({
		width: 440,
		height: 320,
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
	log.info("opening settings window");
	forwardConsole(win.webContents, "settings");
	win.on("closed", () => {
		settingsWin = null;
	});
	win.once("ready-to-show", () => focusWindow(win));

	if (DEV_URL) {
		win.loadURL(`${DEV_URL}/settings.html`);
	} else {
		win.loadFile(join(__dirname, "../dist/settings.html"));
	}
}
