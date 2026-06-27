import {
	app,
	BrowserWindow,
	globalShortcut,
	ipcMain,
	Menu,
	nativeImage,
	session,
	Tray,
} from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyMacOverlay } from "./mac-overlay";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
// __dirname is a native global in the bundled CommonJS output (dist-electron/).

// Agent/accessory activation policy — the macOS-runtime equivalent of DmNote's
// `LSUIElement = true`. MUST run at module load, BEFORE app.whenReady(): AeroSpace
// (and similar AX window managers) evaluate and CACHE a window's manageability the
// instant it's created. If we wait until whenReady the app spends a brief moment as
// a regular (Dock) app, AeroSpace latches onto the window during that phase, and it
// gets shuffled on workspace switches. Set this early and the window is born under
// the accessory policy → classified as a non-managed popup → stays put across spaces.
// (Verified: setting it inside whenReady → captured; setting it here → ignored.)
if (process.platform === "darwin") app.setActivationPolicy("accessory");

// Keep parity with the Tauri build: the saved position lives in pos.toml at the
// repo root (cwd in dev). Only x/y/scale, so a tiny hand-rolled (de)serializer
// avoids a TOML dependency.
const POS_FILE = resolve(process.cwd(), "pos.toml");

interface Pos {
	x: number;
	y: number;
	scale: number;
}

function parsePos(text: string): Pos | null {
	const out: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*(\w+)\s*=\s*([-\d.eE+]+)/);
		if (m) out[m[1]] = Number(m[2]);
	}
	if (["x", "y", "scale"].every((k) => Number.isFinite(out[k]))) {
		return { x: out.x, y: out.y, scale: out.scale };
	}
	return null;
}

function serializePos(p: Pos): string {
	// Force a decimal point so the values round-trip as TOML floats.
	const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
	return `x = ${f(p.x)}\ny = ${f(p.y)}\nscale = ${f(p.scale)}\n`;
}

ipcMain.handle("load-pos", async (): Promise<Pos | null> => {
	try {
		return parsePos(await readFile(POS_FILE, "utf8"));
	} catch {
		return null; // missing on first launch
	}
});

ipcMain.handle("save-pos", async (_e, pos: Pos): Promise<void> => {
	await writeFile(POS_FILE, serializePos(pos));
});

// Whether the overlay is click-through. When locked, mouse events fall through
// to whatever is underneath (the game/desktop) — DmNote's `overlay_locked`.
let overlayLocked = false;

// Set by createTray() so a lock change from any source (menu, hotkey, IPC) keeps
// the tray menu label in sync.
let refreshTrayMenu: () => void = () => {};

function setOverlayLock(win: BrowserWindow, locked: boolean): void {
	overlayLocked = locked;
	// forward:true still delivers mousemove to the renderer (for hover) while
	// clicks pass through — matches Tauri's set_ignore_cursor_events behavior.
	win.setIgnoreMouseEvents(locked, { forward: true });
	if (!win.isDestroyed()) win.webContents.send("overlay:lock-changed", locked);
	refreshTrayMenu();
}

function overlayWindow(): BrowserWindow | undefined {
	return BrowserWindow.getAllWindows()[0];
}

// Registered once (not per-window) so re-creating the window on macOS `activate`
// can't double-register a handler. Each call targets the current overlay window.
function registerOverlayIpc(): void {
	ipcMain.handle("overlay:set-lock", (_e, locked: boolean) => {
		const win = overlayWindow();
		if (win) setOverlayLock(win, Boolean(locked));
	});
	ipcMain.handle("overlay:get-lock", () => overlayLocked);
	ipcMain.handle("overlay:toggle-lock", () => {
		const win = overlayWindow();
		if (win) setOverlayLock(win, !overlayLocked);
		return overlayLocked;
	});
}

function createWindow(): void {
	const win = new BrowserWindow({
		width: 800,
		height: 600,
		transparent: true,
		frame: false, // no title bar / borders
		alwaysOnTop: true,
		hasShadow: false,
		backgroundColor: "#00000000",
		resizable: true,
		// Never become key/main: the overlay must not steal focus from the app
		// underneath. Equivalent to DmNote's macOS set_focusable(false).
		focusable: false,
		skipTaskbar: true,
		// Shown without activation via showInactive() once content is ready.
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Raw AppKit: NSStatusWindowLevel + canJoinAllSpaces|fullScreenAuxiliary +
	// hidesOnDeactivate=NO + orderFrontRegardless. This is the genuine DmNote
	// NSWindow treatment; we drive the window level from AppKit rather than
	// Electron's setAlwaysOnTop level so the behavior matches exactly.
	applyMacOverlay(win);
	// AppKit can reset the level/ordering when the window is reordered, so
	// re-assert on the events where that happens — as DmNote does on focus loss.
	win.on("show", () => applyMacOverlay(win));
	win.on("blur", () => applyMacOverlay(win));

	win.once("ready-to-show", () => {
		win.showInactive(); // show without taking focus (≈ SW_SHOWNOACTIVATE)
		applyMacOverlay(win);
		// Re-assert the current lock state on the freshly (re)created window.
		setOverlayLock(win, overlayLocked);
	});

	if (DEV_URL) {
		win.loadURL(DEV_URL);
	} else {
		win.loadFile(join(__dirname, "../dist/index.html"));
	}
}

// A 16×16 black-on-alpha template PNG (macOS recolors template images for the
// menubar). Embedded as base64 so there's no asset-copy step in dev or prod.
const TRAY_ICON_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAkklEQVR4nGNgwA54gFgXiO2gWBcqRhCAFPkDcQsQrwTivVC8Eirmj88gGSAugmr4BcT/0fAvqFwRVC2GzSCJi1g0ouOLULUoLvGHmk5IMwzvheqB296Cw9m48C+oHrArdKGBRKxmGF4J1QuOJlKcj+wNO6oYQLEXKA5EiqMR5gqKEhIIUJSUkV1CdmZCN4io7AwA2haabYWpswIAAAAASUVORK5CYII=";

// Held in module scope so the Tray isn't garbage-collected (which would remove
// the menubar icon).
let tray: Tray | null = null;

function createTray(): void {
	const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`);
	if (process.platform === "darwin") icon.setTemplateImage(true);
	tray = new Tray(icon);
	tray.setToolTip("Live2D Overlay");

	refreshTrayMenu = () => {
		const menu = Menu.buildFromTemplate([
			{
				label: overlayLocked ? "Unlock (make clickable)" : "Lock (click-through)",
				accelerator: "CommandOrControl+Alt+L",
				click: () => {
					const win = overlayWindow();
					if (win) setOverlayLock(win, !overlayLocked);
				},
			},
			{ type: "separator" },
			{ label: "Quit", role: "quit" },
		]);
		tray?.setContextMenu(menu);
	};
	refreshTrayMenu();
}

app.whenReady().then(() => {
	// Auto-grant the webcam (face tracking) — same trust model as the Tauri app.
	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
		cb(permission === "media");
	});

	registerOverlayIpc();
	createTray();
	createWindow();

	// Global hotkey to toggle click-through. Required because once the overlay is
	// click-through, the renderer can't receive a click to turn it back off.
	globalShortcut.register("CommandOrControl+Alt+L", () => {
		const win = overlayWindow();
		if (win) setOverlayLock(win, !overlayLocked);
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("will-quit", () => {
	globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
