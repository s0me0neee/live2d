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
import { join, sep } from "node:path";
import { applyMacOverlay } from "./mac-overlay";
import { forwardConsole } from "./forward-console";
import { registerModelScheme, handleModelProtocol } from "./model-protocol";
import { openSettings } from "./settings-window";
import {
	loadConfig,
	loadHotkeySync,
	loadUiTogglesSync,
	loadWindowBoundsSync,
	savePosSync,
	saveUiToggle,
	saveWindowBounds,
	setExpressionActive,
	setLockHotkey,
	type UiToggle,
} from "./config";
import { DEFAULT_CONFIG, type Pos, type WindowBounds } from "../src/config";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
// __dirname is a native global in the bundled CommonJS output (dist-electron/).

// Accessory ("agent") activation policy = macOS LSUIElement. MUST run before
// whenReady, or the app is briefly a regular (Dock) app and AeroSpace latches onto
// the window. We deliberately don't call app.setName() to rebrand: it flips the
// policy back to "regular", which re-exposes the overlay to AeroSpace.
if (process.platform === "darwin") app.setActivationPolicy("accessory");

// Must be registered before app `ready`.
registerModelScheme();

// Model directories the custom scheme is allowed to read from (resolved locations of
// loaded models), so the renderer can't pull arbitrary files off disk.
const allowedModelRoots = new Set<string>();
const isAllowedModelPath = (filePath: string): boolean => {
	for (const root of allowedModelRoots) {
		if (filePath === root || filePath.startsWith(root + sep)) return true;
	}
	return false;
};

// Config IPC: the renderer fetches the resolved config at boot, then writes back
// the live transform / expression toggles. All file IO lives in ./config.
ipcMain.handle("config:get", async () => {
	const cfg = await loadConfig();
	if (cfg.model.resolvedLocation) allowedModelRoots.add(cfg.model.resolvedLocation);
	return cfg;
});
// The renderer reports the live model transform as it changes; we hold it in memory
// and write it to the model TOML only at quit (see will-quit).
let lastReportedPos: Pos | null = null;
ipcMain.on("pos:report", (_e, pos: Pos) => {
	lastReportedPos = pos;
});
ipcMain.handle("config:set-expression", (_e, name: string, active: boolean) =>
	setExpressionActive(name, Boolean(active)),
);
ipcMain.handle("config:get-hotkey", () => lockHotkey);
ipcMain.handle("config:set-hotkey", async (_e, accelerator: string) => {
	if (typeof accelerator !== "string" || !registerLockHotkey(accelerator)) return false;
	await setLockHotkey(accelerator);
	return true;
});

const MIN_W = 200;
const MIN_H = 150;

// Loaded before the first createWindow() and kept current so re-creating the
// window (macOS `activate`) restores its geometry.
let savedBounds: WindowBounds | null = null;

let winSaveTimer: ReturnType<typeof setTimeout> | undefined;
function persistBounds(b: WindowBounds): void {
	savedBounds = b;
	clearTimeout(winSaveTimer); // a drag/resize floods updates; hit disk once it settles
	winSaveTimer = setTimeout(() => {
		saveWindowBounds(b).catch((e) => console.warn("save window bounds failed:", e));
	}, 400);
}

function registerWindowIpc(): void {
	ipcMain.handle("window:get-bounds", (): WindowBounds | null => {
		const win = overlayWindow();
		return win && !win.isDestroyed() ? win.getBounds() : null;
	});
	// send (not invoke) so a fast drag isn't gated on round-trips.
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

// When locked, clicks fall through to whatever is underneath.
let overlayLocked = false;

// Set by createTray() so a lock change from any source keeps the menu label in sync.
let refreshTrayMenu: () => void = () => { };

function setOverlayLock(win: BrowserWindow, locked: boolean): void {
	overlayLocked = locked;
	if (win.isDestroyed()) return; // hotkey/tray callbacks fire async; window may be gone
	// forward:true still delivers mousemove (for hover) while clicks pass through.
	win.setIgnoreMouseEvents(locked, { forward: true });
	win.webContents.send("overlay:lock-changed", locked);
	refreshTrayMenu();
}

// Tracked so it's distinguishable from the settings window (also a BrowserWindow).
let overlay: BrowserWindow | null = null;
function overlayWindow(): BrowserWindow | undefined {
	return overlay && !overlay.isDestroyed() ? overlay : undefined;
}

function toggleLock(): void {
	const win = overlayWindow();
	if (win) setOverlayLock(win, !overlayLocked);
}

// The global hotkey that toggles the lock. Set from config at boot, re-bound from
// the settings window. Essential because once click-through the renderer can't
// receive a click to unlock.
let lockHotkey = DEFAULT_CONFIG.lockHotkey;

// Registers the new accelerator BEFORE dropping the old one, so a failure (invalid
// or already-taken accelerator — register can even throw) leaves the previous
// binding intact rather than unbinding everything. Returns false on failure so the
// settings UI can report it.
function registerLockHotkey(accelerator: string): boolean {
	if (accelerator === lockHotkey && globalShortcut.isRegistered(accelerator)) return true;

	let registered = false;
	try {
		registered = globalShortcut.register(accelerator, toggleLock);
	} catch {
		registered = false;
	}
	if (!registered) return false;

	if (lockHotkey !== accelerator) globalShortcut.unregister(lockHotkey);
	lockHotkey = accelerator;
	refreshTrayMenu();
	return true;
}

// UI toggles (FPS counter, expression list): persisted in config.toml and pushed to
// the renderer to show/hide live. Seeded from config at boot (loadUiTogglesSync).
const uiToggles: Record<UiToggle, boolean> = {
	showFps: DEFAULT_CONFIG.showFps,
	showExpressions: DEFAULT_CONFIG.showExpressions,
};
const UI_CHANNEL: Record<UiToggle, string> = {
	showFps: "ui:show-fps",
	showExpressions: "ui:show-expressions",
};

function setUiToggle(key: UiToggle, value: boolean): void {
	uiToggles[key] = value;
	overlayWindow()?.webContents.send(UI_CHANNEL[key], value);
	saveUiToggle(key, value).catch((e) => console.warn(`save ${key} failed:`, e));
}

// Registered once (not per-window) so re-creating the window can't double-register.
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
	overlay = new BrowserWindow({
		title: "web2d",
		width: b?.width ?? 800,
		height: b?.height ?? 600,
		...(b ? { x: b.x, y: b.y } : {}), // saved position, else let Electron center
		minWidth: MIN_W,
		minHeight: MIN_H,
		transparent: true,
		frame: false,
		alwaysOnTop: true,
		hasShadow: false,
		backgroundColor: "#00000000",
		// AeroSpace ignores an accessory app's window only when it has no AX close
		// button (its isWindowHeuristic). Disabling these at creation drops the close
		// button and its NSWindow style-mask bit; the guide still moves/resizes the
		// window via setBounds. (Clearing the bit live via setStyleMask: recurses.)
		closable: false,
		minimizable: false,
		maximizable: false,
		resizable: false,
		fullscreenable: false,
		focusable: false, // never steal focus from the app underneath
		skipTaskbar: true,
		show: false, // shown via showInactive() once ready
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	const win = overlay;
	forwardConsole(win.webContents, "renderer");

	// The DmNote NSWindow treatment (status level, joins all Spaces, floats over
	// fullscreen, no hide-on-deactivate). AppKit can reset it on reorder, so re-apply
	// on show/blur.
	applyMacOverlay(win);
	win.on("show", () => applyMacOverlay(win));
	win.on("blur", () => applyMacOverlay(win));

	win.once("ready-to-show", () => {
		win.showInactive(); // show without taking focus
		applyMacOverlay(win);
		setOverlayLock(win, overlayLocked);
	});

	if (DEV_URL) {
		win.loadURL(DEV_URL);
	} else {
		win.loadFile(join(__dirname, "../dist/index.html"));
	}
}

// 16×16 template PNG (macOS recolors template images for the menubar), embedded as
// base64 so there's no asset-copy step.
const TRAY_ICON_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAkklEQVR4nGNgwA54gFgXiO2gWBcqRhCAFPkDcQsQrwTivVC8Eirmj88gGSAugmr4BcT/0fAvqFwRVC2GzSCJi1g0ouOLULUoLvGHmk5IMwzvheqB296Cw9m48C+oHrArdKGBRKxmGF4J1QuOJlKcj+wNO6oYQLEXKA5EiqMR5gqKEhIIUJSUkV1CdmZCN4io7AwA2haabYWpswIAAAAASUVORK5CYII=";

// Module scope so the Tray isn't GC'd (which would drop the menubar icon).
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
				accelerator: lockHotkey,
				click: toggleLock,
			},
			{
				label: "Recenter face tracking",
				click: () => overlayWindow()?.webContents.send("face:recenter"),
			},
			{
				// No live re-apply path yet; reloading the renderer re-fetches the
				// config and re-runs setup, applying edited config.toml / model values.
				label: "Reload config",
				click: () => overlayWindow()?.webContents.reload(),
			},
			{ type: "separator" },
			{
				label: "Show FPS counter",
				type: "checkbox",
				checked: uiToggles.showFps,
				click: (item) => setUiToggle("showFps", item.checked),
			},
			{
				label: "Show expression list",
				type: "checkbox",
				checked: uiToggles.showExpressions,
				click: (item) => setUiToggle("showExpressions", item.checked),
			},
			{ type: "separator" },
			{ label: "Settings…", click: openSettings },
			{ label: "Quit", role: "quit" },
		]);
		tray?.setContextMenu(menu);
	};
	refreshTrayMenu();
}

app.whenReady().then(() => {
	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
		cb(permission === "media"); // auto-grant the webcam for face tracking
	});

	handleModelProtocol(isAllowedModelPath);

	// Synchronous so createWindow() runs in this launch tick — an async gap here
	// lets AeroSpace capture the overlay.
	savedBounds = loadWindowBoundsSync();
	Object.assign(uiToggles, loadUiTogglesSync());

	registerOverlayIpc();
	registerWindowIpc();
	createTray();
	createWindow();

	lockHotkey = loadHotkeySync();
	if (!registerLockHotkey(lockHotkey)) {
		console.warn(`[overlay] could not register lock hotkey "${lockHotkey}"`);
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("will-quit", () => {
	if (lastReportedPos) savePosSync(lastReportedPos);
	globalShortcut.unregisterAll();
	tray?.destroy(); // release the menubar icon so it can't linger as a ghost
	tray = null;
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
