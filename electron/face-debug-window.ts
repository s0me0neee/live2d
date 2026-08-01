import { BrowserWindow } from "electron";
import { join } from "node:path";
import { forwardConsole } from "./forward-console";
import { createLogger } from "./log";
import { focusWindow } from "./window-utils";
import type { FaceResult } from "../src/face-worker";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const log = createLogger("face-debug");

// Single instance: reopening focuses the existing window instead of stacking.
let debugWin: BrowserWindow | null = null;

export function openFaceDebug(): void {
	if (debugWin && !debugWin.isDestroyed()) {
		focusWindow(debugWin);
		return;
	}

	const win = new BrowserWindow({
		width: 420,
		height: 560,
		title: "web2d face tracking debug",
		frame: false,
		transparent: true,
		hasShadow: true,
		backgroundColor: "#00000000",
		fullscreenable: false,
		minimizable: false,
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	debugWin = win;
	log.info("opening face tracking debug window");
	forwardConsole(win.webContents, "face-debug");
	win.on("closed", () => {
		debugWin = null;
	});
	win.once("ready-to-show", () => focusWindow(win));

	if (DEV_URL) {
		win.loadURL(`${DEV_URL}/face-debug.html`);
	} else {
		win.loadFile(join(__dirname, "../dist/face-debug.html"));
	}
}

// Called for every detection result; no-ops (cheap) when the window isn't open.
export function sendFaceDebugData(result: FaceResult): void {
	if (debugWin && !debugWin.isDestroyed()) debugWin.webContents.send("face-debug:data", result);
}
