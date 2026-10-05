import { BrowserWindow } from "electron";
import { join } from "node:path";
import { forwardConsole } from "./forward-console";
import { createLogger } from "./log";
import { focusWindow } from "./window-utils";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const log = createLogger("settings");

// Single instance: reopening focuses the existing window instead of stacking.
let settingsWin: BrowserWindow | null = null;

// So main.ts can push config:changed broadcasts here too, alongside the overlay window.
export function getSettingsWindow(): BrowserWindow | undefined {
	return settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
}

export function openSettings(): void {
	if (settingsWin && !settingsWin.isDestroyed()) {
		focusWindow(settingsWin);
		return;
	}

	// A plain, focusable window — unlike the overlay it must take keyboard focus to
	// capture a shortcut, so it gets no applyMacOverlay treatment. Tall enough for the
	// full settings page (model/overlay/feel/smoothing/eyes/jaw/physics/cursor/display/
	// gain/expressions/hotkeys); resizable + the page's own scroll cover the rest.
	const win = new BrowserWindow({
		width: 480,
		height: 760,
		minWidth: 420,
		minHeight: 420,
		title: "web2d settings",
		resizable: true,
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
