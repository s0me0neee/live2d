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
import { createLogger, color } from "./log";
import {
	loadConfig,
	loadHotkeysSync,
	loadUiTogglesSync,
	loadWindowBoundsSync,
	savePosSync,
	saveUiToggle,
	saveWindowBounds,
	setExpressionActive,
	setHotkey,
	type UiToggle,
} from "./config";
import { DEFAULT_CONFIG, type HotkeyId, type Pos, type WindowBounds } from "../src/config";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
// __dirname is a native global in the bundled CommonJS output (dist-electron/).

const log = createLogger("main");

// Window locking (click-through via setIgnoreMouseEvents) and the OS-window
// move/resize guide are disabled on Linux: a Wayland client can't self-position, and
// the only ways back out of click-through are the global hotkey (not wired for
// Wayland) and the tray (needs an SNI host), so locking there can strand the overlay.
// Gated on `linux` specifically — macOS works today and Windows keeps these for
// future support.
const IS_LINUX = process.platform === "linux";

// Use the native Wayland Ozone backend on Linux instead of falling back to XWayland.
// Under XWayland, Chromium derives devicePixelRatio from the X font DPI (e.g. 1.047
// here) rather than the compositor's real scale, so the page lays out wider than the
// actual window surface and right/bottom-anchored UI renders off the window edge. The
// native backend reports the true scale and the correct window coordinates. Must be
// set before `whenReady`. GlobalShortcutsPortal makes globalShortcut work on Wayland.
if (IS_LINUX) {
	app.commandLine.appendSwitch("ozone-platform-hint", "auto");
	app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
	// Pin devicePixelRatio to 1. On this Wayland session Chromium derives a 1.046875
	// scale despite the compositor reporting scale 1.0, so it renders a buffer ~4.7%
	// wider than the window and clips the surplus on the right/bottom — which pushed
	// the right-anchored expression panel off the window edge. (A HiDPI monitor at a
	// real >1 compositor scale would want this removed.)
	app.commandLine.appendSwitch("force-device-scale-factor", "1");
}

// Accessory ("agent") activation policy = macOS LSUIElement. MUST run before
// whenReady, or the app is briefly a regular (Dock) app and AeroSpace latches onto
// the window. We deliberately don't call app.setName() to rebrand: it flips the
// policy back to "regular", which re-exposes the overlay to AeroSpace.
if (process.platform === "darwin") {
	app.setActivationPolicy("accessory");
	log.debug("activation policy → accessory (LSUIElement)");
}

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
	if (cfg.model.resolvedLocation) {
		allowedModelRoots.add(cfg.model.resolvedLocation);
		log.info(
			`model ${color.bold(cfg.modelName)} → ${color.dim(cfg.model.resolvedLocation)}`,
			color.gray(
				`(${Object.keys(cfg.model.gain).length} gain, ${Object.keys(cfg.model.expressions).length} expressions)`,
			),
		);
	} else {
		log.warn(`model ${color.bold(cfg.modelName)} has no resolvable location — nothing will load`);
	}
	return cfg;
});
// The renderer reports the live model transform on each drag-stop / zoom. Persist it
// debounced — the transform is Pixi-internal (unlike the OS window it has no AeroSpace
// implication), so there's no reason to defer to quit, where a SIGTERM/SIGINT kill
// (how `pnpm dev` stops) would never run will-quit and the last drag would be lost.
let lastReportedPos: Pos | null = null;
let posSaveTimer: ReturnType<typeof setTimeout> | undefined;
ipcMain.on("pos:report", (_e, pos: Pos) => {
	lastReportedPos = pos;
	clearTimeout(posSaveTimer); // coalesce the burst of reports a wheel-zoom emits
	posSaveTimer = setTimeout(() => {
		log.debug(`saved model pos ${color.gray(`(${pos.x.toFixed(0)},${pos.y.toFixed(0)} @ ${pos.scale.toFixed(2)}×)`)}`);
		savePosSync(pos);
	}, 400);
});
ipcMain.handle("config:set-expression", (_e, name: string, active: boolean) =>
	setExpressionActive(name, Boolean(active)),
);
ipcMain.handle("config:get-hotkey", (_e, id: HotkeyId) => (id in hotkeys ? hotkeys[id] : ""));
ipcMain.handle("config:set-hotkey", async (_e, id: HotkeyId, accelerator: string) => {
	if (id === "lock" && IS_LINUX) return false; // lock system disabled on Linux
	if (typeof accelerator !== "string" || !(id in hotkeys) || !applyHotkey(id, accelerator)) return false;
	await setHotkey(id, accelerator);
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
		saveWindowBounds(b).catch((e) => log.warn("save window bounds failed:", e));
	}, 400);
}

// The renderer's move/resize guide drives the OS window through these. Off on Linux —
// a Wayland client can't self-position, so setBounds(x,y) is a no-op and the guide is
// disabled renderer-side too. macOS and Windows keep it.
function registerWindowIpc(): void {
	if (IS_LINUX) return;
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
	if (IS_LINUX) return; // lock disabled on Linux; overlay stays clickable
	overlayLocked = locked;
	if (win.isDestroyed()) return; // hotkey/tray callbacks fire async; window may be gone
	// forward:true still delivers mousemove (for hover) while clicks pass through.
	win.setIgnoreMouseEvents(locked, { forward: true });
	win.webContents.send("overlay:lock-changed", locked);
	refreshTrayMenu();
	log.info(`overlay ${locked ? color.yellow("locked (click-through)") : color.green("unlocked (clickable)")}`);
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

// The configurable global shortcuts and the action each fires. The lock hotkey is
// essential because once click-through the renderer can't receive a click to
// unlock; recenter mirrors the tray "Recenter face tracking" item. "" = unbound.
const HOTKEY_ACTION: Record<HotkeyId, () => void> = {
	lock: toggleLock,
	recenter: () => {
		log.info("recenter face tracking");
		overlayWindow()?.webContents.send("face:recenter");
	},
};
const hotkeys: Record<HotkeyId, string> = {
	lock: DEFAULT_CONFIG.lockHotkey,
	recenter: DEFAULT_CONFIG.recenterHotkey,
};

// Binds `accelerator` to the hotkey's action, replacing any previous binding. ""
// unbinds (no shortcut). Registers the new accelerator BEFORE dropping the old one
// so a failure (invalid or already-taken accelerator — register can even throw)
// leaves the previous binding intact. Returns false only when a non-empty
// accelerator can't be registered, so the settings UI can report it.
function applyHotkey(id: HotkeyId, accelerator: string): boolean {
	const prev = hotkeys[id];
	const isBound = (a: string) => a !== "" && globalShortcut.isRegistered(a);
	if (accelerator === prev && (accelerator === "" || isBound(accelerator))) return true;

	if (accelerator !== "") {
		let registered = false;
		try {
			registered = globalShortcut.register(accelerator, HOTKEY_ACTION[id]);
		} catch {
			registered = false;
		}
		if (!registered) return false;
	}

	if (prev !== "" && prev !== accelerator) globalShortcut.unregister(prev);
	hotkeys[id] = accelerator;
	refreshTrayMenu();
	log.info(`hotkey ${color.bold(id)} → ${accelerator ? color.cyan(accelerator) : color.gray("(unbound)")}`);
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
	log.info(`${key} ${value ? color.green("on") : color.gray("off")}`);
	saveUiToggle(key, value).catch((e) => log.warn(`save ${key} failed:`, e));
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
		log.info(`loading renderer from ${color.cyan(DEV_URL)}`);
		win.loadURL(DEV_URL);
	} else {
		win.loadFile(join(__dirname, "../dist/index.html"));
	}
	log.ok(
		`overlay window created ${color.gray(b ? `restored ${b.width}×${b.height} @ (${b.x},${b.y})` : "centered (no saved bounds)")}`,
	);
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
			...(IS_LINUX
				? []
				: [
						{
							label: overlayLocked ? "Unlock (make clickable)" : "Lock (click-through)",
							accelerator: hotkeys.lock || undefined,
							click: toggleLock,
						},
					]),
			{
				label: "Recenter face tracking",
				accelerator: hotkeys.recenter || undefined,
				click: HOTKEY_ACTION.recenter,
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
	log.ok(`web2d ready ${color.gray(`(electron ${process.versions.electron}, node ${process.versions.node})`)}`);

	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
		if (permission === "media") log.info("granting webcam permission for face tracking");
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

	const saved = loadHotkeysSync();
	for (const id of Object.keys(hotkeys) as HotkeyId[]) {
		if (id === "lock" && IS_LINUX) continue; // lock system disabled on Linux
		if (!applyHotkey(id, saved[id])) {
			log.error(`could not register ${id} hotkey "${saved[id]}" — in use by another app?`);
		}
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("will-quit", () => {
	clearTimeout(posSaveTimer);
	if (lastReportedPos) {
		log.info(`saving model position ${color.gray(`(${lastReportedPos.x.toFixed(0)},${lastReportedPos.y.toFixed(0)} @ ${lastReportedPos.scale.toFixed(2)}×)`)}`);
		savePosSync(lastReportedPos);
	}
	globalShortcut.unregisterAll();
	tray?.destroy(); // release the menubar icon so it can't linger as a ghost
	tray = null;
	log.info("quit");
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
