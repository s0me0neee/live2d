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
import { join } from "node:path";
import { applyMacOverlay } from "./mac-overlay";
import {
	loadConfig,
	loadWindowBounds,
	savePos,
	saveWindowBounds,
	setExpressionActive,
} from "./config";
import type { Pos, WindowBounds } from "../src/config";

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

// Brand the app as "web2d" instead of the default "Electron" (menu bar, About
// panel, app.getName()). Must run before whenReady so the name is set when the
// app menu/process metadata is first read.
app.setName("web2d");
app.setAppUserModelId("com.web2d.app"); // Windows taskbar grouping / notifications
process.title = "web2d"; // main-process name in `ps` (Activity Monitor still shows Electron until packaged)

// Config IPC. The renderer fetches the resolved config once at boot, then writes
// back the live transform / expression toggles as the user interacts. All file
// IO lives in ./config (the model's TOML is the single source of truth).
ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:save-pos", (_e, pos: Pos) => savePos(pos));
ipcMain.handle("config:set-expression", (_e, name: string, active: boolean) =>
	setExpressionActive(name, Boolean(active)),
);

// --- overlay window geometry -------------------------------------------------
// The window can be moved/resized via the in-app guide (shown when unlocked).
// Bounds persist in config.toml's [window] table (see ./config).
const MIN_W = 200;
const MIN_H = 150;

// Last-known bounds: loaded before the first createWindow() and kept current as
// the user drags/resizes, so re-creating the window (macOS `activate`) restores it.
let savedBounds: WindowBounds | null = null;

let winSaveTimer: ReturnType<typeof setTimeout> | undefined;
function persistBounds(b: WindowBounds): void {
	savedBounds = b;
	// Debounce: a drag/resize emits a flurry of updates; hit disk once it settles.
	clearTimeout(winSaveTimer);
	winSaveTimer = setTimeout(() => {
		saveWindowBounds(b).catch((e) => console.warn("save window bounds failed:", e));
	}, 400);
}

// Registered once (like registerOverlayIpc). The renderer drives the OS window
// from its move/resize guide using global screen coordinates.
function registerWindowIpc(): void {
	ipcMain.handle("window:get-bounds", (): WindowBounds | null => {
		const win = overlayWindow();
		return win && !win.isDestroyed() ? win.getBounds() : null;
	});
	// Fire-and-forget (send, not invoke) so a fast drag isn't gated on round-trips.
	ipcMain.on("window:set-bounds", (_e, b: WindowBounds) => {
		const win = overlayWindow();
		if (!win || win.isDestroyed()) return;
		const rect: WindowBounds = {
			x: Math.round(b.x),
			y: Math.round(b.y),
			width: Math.max(MIN_W, Math.round(b.width)),
			height: Math.max(MIN_H, Math.round(b.height)),
		};
		win.setBounds(rect);
		persistBounds(rect);
	});
}

// Whether the overlay is click-through. When locked, mouse events fall through
// to whatever is underneath (the game/desktop) — DmNote's `overlay_locked`.
let overlayLocked = false;

// Set by createTray() so a lock change from any source (menu, hotkey, IPC) keeps
// the tray menu label in sync.
let refreshTrayMenu: () => void = () => {};

function setOverlayLock(win: BrowserWindow, locked: boolean): void {
	overlayLocked = locked;
	// A window can be torn down between a caller grabbing it and this running
	// (hotkey/tray callbacks fire async); touching a destroyed window throws.
	if (win.isDestroyed()) return;
	// forward:true still delivers mousemove to the renderer (for hover) while
	// clicks pass through — matches Tauri's set_ignore_cursor_events behavior.
	win.setIgnoreMouseEvents(locked, { forward: true });
	win.webContents.send("overlay:lock-changed", locked);
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
	const b = savedBounds;
	const win = new BrowserWindow({
		title: "web2d",
		width: b?.width ?? 800,
		height: b?.height ?? 600,
		// Only pass x/y when we have a saved position; otherwise let Electron center.
		...(b ? { x: b.x, y: b.y } : {}),
		minWidth: MIN_W,
		minHeight: MIN_H,
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
	tray.setToolTip("web2d");

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

app.whenReady().then(async () => {
	// Auto-grant the webcam (face tracking) — same trust model as the Tauri app.
	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
		cb(permission === "media");
	});

	// Restore the last window geometry before creating the window so it opens in place.
	savedBounds = await loadWindowBounds();

	registerOverlayIpc();
	registerWindowIpc();
	createTray();
	createWindow();

	// Global hotkey to toggle click-through. Required because once the overlay is
	// click-through, the renderer can't receive a click to turn it back off.
	const ok = globalShortcut.register("CommandOrControl+Alt+L", () => {
		const win = overlayWindow();
		if (win) setOverlayLock(win, !overlayLocked);
	});
	if (!ok) {
		// Another app already owns the combo. The tray menu still toggles the lock.
		console.warn("[overlay] could not register CommandOrControl+Alt+L hotkey");
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("will-quit", () => {
	globalShortcut.unregisterAll();
	// Release the menubar icon explicitly so it can't linger as a ghost.
	tray?.destroy();
	tray = null;
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
