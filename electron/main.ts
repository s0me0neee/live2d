import {
	app,
	BrowserWindow,
	globalShortcut,
	ipcMain,
	Menu,
	nativeImage,
	screen,
	session,
	Tray,
} from "electron";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { applyMacOverlay } from "./mac-overlay";
import { IS_WAYLAND } from "./platform";
import { forwardConsole } from "./forward-console";
import { registerModelScheme, handleModelProtocol } from "./model-protocol";
import { openSettings } from "./settings-window";
import { openFaceDebug, sendFaceDebugData } from "./face-debug-window";
import type { FaceResult } from "../src/face-worker";
import { createLogger, color } from "./log";
import {
	loadConfig,
	loadCursorLookSync,
	loadHotkeysSync,
	loadHyprlandAutoBindSync,
	loadUiTogglesSync,
	loadWindowBoundsSync,
	savePosSync,
	saveUiToggle,
	saveWindowBoundsSync,
	setExpressionActive,
	setHotkey,
	type UiToggle,
} from "./config";
import { DEFAULT_CONFIG, type HotkeyId, type Pos, type WindowBounds } from "../src/config";
import type { Shortcut } from "@web2d/global-hotkey";
import type { ClientInfo, CursorPos, WindowRule } from "@web2d/overlay_hyprland";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
// __dirname is a native global in the bundled CommonJS output (dist-electron/).

const log = createLogger("main");

// The renderer's move/resize guide is Wayland-disabled (Wayland can't self-position);
// window locking stays enabled there since the portal hotkey + tray Lock item are a
// way back out of click-through. X11 gets the same guide/native-hotkey path as macOS.

// Native Wayland Ozone backend, not XWayland: XWayland derives devicePixelRatio from
// X font DPI rather than the compositor's real scale, mis-sizing the page. Must be set
// before `whenReady`.
if (IS_WAYLAND) {
	app.commandLine.appendSwitch("ozone-platform-hint", "auto");
	app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
	// This Wayland session reports devicePixelRatio 1.046875 despite compositor scale
	// 1.0, clipping right/bottom-anchored UI. Pin to 1 until a real HiDPI monitor needs it.
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
// Fire-and-forget relay from the overlay renderer to the face-debug window (if open).
ipcMain.on("face-debug:data", (_e, result: FaceResult) => sendFaceDebugData(result));
ipcMain.handle("config:set-expression", (_e, name: string, active: boolean) =>
	setExpressionActive(name, Boolean(active)),
);
ipcMain.handle("config:get-hotkey", (_e, id: HotkeyId) => (id in hotkeys ? hotkeys[id] : ""));
ipcMain.handle("config:set-hotkey", async (_e, id: HotkeyId, accelerator: string) => {
	if (typeof accelerator !== "string" || !(id in hotkeys)) return false;
	if (IS_WAYLAND) {
		// The portal shortcut id is bound once at startup; the accelerator is only an
		// advisory preferredTrigger there. But when hyprlandAutoBind is on we drive the
		// real key via the compositor keyword IPC, so a change can take effect live.
		hotkeys[id] = accelerator;
		await setHotkey(id, accelerator);
		if (loadHyprlandAutoBindSync()) applyHyprlandBind(id, accelerator);
		return true;
	}
	if (!applyHotkey(id, accelerator)) return false;
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
	winSaveTimer = setTimeout(() => saveWindowBoundsSync(b), 400);
}

// The renderer's move/resize guide drives the OS window through these. Off on
// Wayland — the renderer guide is disabled there (Wayland can't self-position); the
// window is created `resizable` instead and native resizes persist via the `resize`
// listener in createWindow. macOS, Windows and X11 Linux keep the guide.
function registerWindowIpc(): void {
	if (IS_WAYLAND) return;
	ipcMain.handle("window:get-bounds", (): WindowBounds | null => {
		const win = overlayWindow();
		return win && !win.isDestroyed() ? win.getBounds() : null;
	});
	// send (not invoke) so a fast drag isn't gated on round-trips.
	ipcMain.on("window:set-bounds", (_e, b: WindowBounds) => {
		const win = overlayWindow();
		if (!win || win.isDestroyed()) return;
		if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return; // malformed payload
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
	// forward:true still delivers mousemove (for hover) while clicks pass through — but
	// it's macOS/Windows-only, so hover reactions while locked are lost on Linux/Wayland.
	win.setIgnoreMouseEvents(locked, { forward: true });
	if (onHyprland()) applyHyprlandLock(locked); // toggle the no-focus/border/blur overlay rules
	if (locked) startCursorPoll(win);
	else stopCursorPoll();
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
const HOTKEY_DESCRIPTION: Record<HotkeyId, string> = {
	lock: "Toggle click-through lock",
	recenter: "Recenter face tracking",
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

// On Wayland, global hotkeys go through the XDG GlobalShortcuts portal — Electron's
// globalShortcut never declares an app id, so the compositor rejects its session (X11
// has no such restriction, so it keeps using globalShortcut directly). The
// `global_hotkey` native module registers shortcut *ids*; the user binds real keys
// in hyprland.conf (`bind = CTRL ALT, R, global, web2d:recenter`) or via
// hyprlandAutoBind. The config accelerator is only an advisory `preferredTrigger`.
const PORTAL_APP_ID = "web2d";

interface GlobalHotkeyModule {
	start(appId: string, shortcuts: Shortcut[], onActivated: (err: Error | null, id: string) => void): void;
}

// Runtime compositor control (Hyprland). `setKeyword` is the reply-checked `hyprctl
// keyword` equivalent over the IPC socket; `setWindowRules` applies dynamic
// `windowrule[<name>]:<prop> <value>` keywords (value "unset" clears one).
interface OverlayHyprlandModule {
	isHyprland(): boolean;
	setKeyword(key: string, value: string): void;
	setWindowRules(name: string, rules: WindowRule[]): void;
	getClients(): ClientInfo[];
	getCursorPos(): CursorPos;
	moveWindowTo(address: string, x: number, y: number): void;
	resizeWindowTo(address: string, width: number, height: number): void;
}

// undefined = not yet attempted; null = load failed (off-Linux, or module missing).
let hyprMod: OverlayHyprlandModule | null | undefined;
function hyprland(): OverlayHyprlandModule | null {
	if (hyprMod !== undefined) return hyprMod;
	try {
		hyprMod = require("@web2d/overlay_hyprland") as OverlayHyprlandModule;
		log.debug("overlay_hyprland native module loaded");
	} catch (e) {
		log.warn("overlay_hyprland native module unavailable; compositor control disabled:", e);
		hyprMod = null;
	}
	return hyprMod;
}

// Cached so the per-lock-toggle rule application doesn't re-probe (and so it stays
// silent on non-Hyprland Linux instead of warning on every toggle).
let isHyprlandSession: boolean | undefined;
function onHyprland(): boolean {
	if (isHyprlandSession !== undefined) return isHyprlandSession;
	const h = hyprland();
	try {
		isHyprlandSession = h ? h.isHyprland() : false;
	} catch {
		isHyprlandSession = false;
	}
	return isHyprlandSession;
}

// The Linux analogue of applyMacOverlay, via `windowrule[web2d]:…`. BASE (float/pin/
// opacity) applies once at startup and is never toggled; LOCK is the no-focus overlay
// behavior toggled with click-through.
const HYPRLAND_RULE_SELECTOR = "web2d";
const HYPRLAND_BASE_RULES: WindowRule[] = [
	{ prop: "opacity", value: "1.0 override 1.0 override 1.0 override" },
	{ prop: "float", value: "true" },
	{ prop: "pin", value: "true" },
];
const HYPRLAND_LOCK_RULES: WindowRule[] = [
	{ prop: "no_focus", value: "true" },
	{ prop: "border_size", value: "0" },
	{ prop: "no_blur", value: "true" },
	{ prop: "no_dim", value: "true" },
	{ prop: "no_shadow", value: "true" },
	{ prop: "no_follow_mouse", value: "true" },
];
// Unlock flips each rule to its off value (not "unset") so the change is explicit;
// border_size 5 keeps the window visibly bordered/findable while it's movable.
const HYPRLAND_UNLOCK_RULES: WindowRule[] = [
	{ prop: "no_focus", value: "false" },
	{ prop: "border_size", value: "5" },
	{ prop: "no_blur", value: "false" },
	{ prop: "no_dim", value: "false" },
	{ prop: "no_shadow", value: "false" },
	{ prop: "no_follow_mouse", value: "false" },
];
const clearedRules = (rules: WindowRule[]): WindowRule[] =>
	rules.map((r) => ({ prop: r.prop, value: "unset" }));

function applyHyprlandRules(rules: WindowRule[]): boolean {
	if (!onHyprland()) return false;
	const h = hyprland();
	if (!h) return false;
	try {
		h.setWindowRules(HYPRLAND_RULE_SELECTOR, rules);
		return true;
	} catch (e) {
		log.warn(`hyprland window rules failed: ${(e as Error).message}`);
		return false;
	}
}

// Startup: apply the always-on rules (opacity + float + pin). The overlay no-focus set
// follows the lock (setOverlayLock → applyHyprlandLock).
function startLinuxOverlayRules(): void {
	if (!onHyprland()) {
		log.info("not a Hyprland session; skipping overlay window rules");
		return;
	}
	if (applyHyprlandRules(HYPRLAND_BASE_RULES)) {
		log.ok(`hyprland base window rules applied ${color.gray("(opacity, float, pin)")}`);
	}
}

function applyHyprlandLock(locked: boolean): void {
	if (!onHyprland()) return;
	if (applyHyprlandRules(locked ? HYPRLAND_LOCK_RULES : HYPRLAND_UNLOCK_RULES)) {
		log.debug(`hyprland overlay rules ${locked ? "applied" : "cleared"}`);
	}
}

// Our overlay window as the compositor sees it. The Electron main process owns the
// Wayland connection, so Hyprland reports our windows under process.pid; the settings
// window shares that pid but has a distinct title ("web2d settings"), so match the
// overlay by its exact title.
function overlayHyprlandClient(): ClientInfo | null {
	const h = hyprland();
	if (!h) return null;
	try {
		const mine = h.getClients().filter((c) => c.pid === process.pid);
		return mine.find((c) => c.title === "web2d") ?? mine[0] ?? null;
	} catch (e) {
		log.warn(`hyprland getClients failed: ${(e as Error).message}`);
		return null;
	}
}

// Wayland won't let Electron self-position, so restore the saved geometry by dispatching
// move/resize on the mapped window (the Linux analogue of createWindow's x/y/w/h). The
// window maps a moment after showInactive(), so retry until it appears in getClients.
function restoreLinuxBounds(): void {
	if (!onHyprland() || !savedBounds) return;
	const target = savedBounds;
	let attempts = 0;
	const tryRestore = (): void => {
		const c = overlayHyprlandClient();
		if (!c) {
			if (attempts++ < 20) return void setTimeout(tryRestore, 100);
			log.warn("hyprland: overlay window not found in clients; can't restore bounds");
			return;
		}
		const h = hyprland();
		if (!h) return;
		try {
			h.resizeWindowTo(c.address, target.width, target.height);
			h.moveWindowTo(c.address, target.x, target.y);
			log.ok(`hyprland restored bounds ${color.gray(`${target.width}×${target.height} @ (${target.x},${target.y})`)}`);
		} catch (e) {
			log.warn(`hyprland restore bounds failed: ${(e as Error).message}`);
		}
	};
	tryRestore();
}

// Click-through means the renderer gets no pointer events at all (Wayland's
// no_follow_mouse, or forward:true's hover only covering the small overlay window), so
// poll the OS cursor instead and hand the renderer window-local coordinates. Hyprland
// gets its own cursor+geometry source (hyprctl over the native module) because Wayland
// hides the global cursor from Electron's `screen` API off that compositor's own
// protocol — which is also why this stays off entirely on non-Hyprland Wayland (X11
// still gets it via `screen`, same as macOS/Windows).
const CURSOR_GEOMETRY_MS = 500; // the overlay rarely moves, so don't re-read it per tick

let cursorTimer: ReturnType<typeof setInterval> | undefined;

function startCursorPoll(win: BrowserWindow): void {
	if (cursorTimer) return;
	if (IS_WAYLAND && !onHyprland()) return; // no portable cursor source off Hyprland on Wayland
	const { enabled, fps } = loadCursorLookSync();
	if (!enabled) return;
	const useHyprland = onHyprland();
	const h = useHyprland ? hyprland() : null;
	if (useHyprland && !h) return;

	let geometry: { x: number; y: number } | null = null;
	let geometryAt = 0;
	let lastX = NaN;
	let lastY = NaN;

	cursorTimer = setInterval(() => {
		if (win.isDestroyed()) return stopCursorPoll();
		const now = Date.now();
		if (now - geometryAt > CURSOR_GEOMETRY_MS) {
			geometry = useHyprland ? overlayHyprlandClient() : win.getBounds();
			geometryAt = now;
		}
		if (!geometry) return;

		let cursor: { x: number; y: number };
		try {
			cursor = useHyprland ? h!.getCursorPos() : screen.getCursorScreenPoint();
		} catch (e) {
			log.warn(`cursor poll failed, cursor look off: ${(e as Error).message}`);
			return stopCursorPoll();
		}
		if (cursor.x === lastX && cursor.y === lastY) return; // an idle cursor costs no IPC
		lastX = cursor.x;
		lastY = cursor.y;
		win.webContents.send("cursor:pos", { x: cursor.x - geometry.x, y: cursor.y - geometry.y });
	}, Math.round(1000 / Math.max(1, fps)));

	log.debug(`cursor look polling at ${fps}fps${useHyprland ? " (hyprland)" : ""}`);
}

function stopCursorPoll(): void {
	clearInterval(cursorTimer);
	cursorTimer = undefined;
}

// Best-effort `hyprctl keyword`; a rejected keyword throws (setKeyword checks the
// reply), which we log rather than propagate.
function hyprSetKeyword(key: string, value: string): boolean {
	const h = hyprland();
	if (!h) return false;
	try {
		h.setKeyword(key, value);
		log.debug(`hypr keyword ${key} ${value} → ok`);
		return true;
	} catch (e) {
		log.warn(`hypr keyword "${key} ${value}" failed (not a Hyprland session?): ${(e as Error).message}`);
		return false;
	}
}

// The host portal registry only accepts an app id that resolves to a loadable .desktop
// whose Exec points at a real binary. process.execPath is always absolute + resolvable
// (the portal never execs it — Exec is used purely for app-id validation).
function ensureDesktopEntry(): void {
	const dir = join(homedir(), ".local", "share", "applications");
	const file = join(dir, `${PORTAL_APP_ID}.desktop`);
	const desired = `[Desktop Entry]\nType=Application\nName=web2d\nExec=${process.execPath}\n`;
	try {
		// Rewrite when stale, not just when missing: an Electron upgrade changes
		// process.execPath, and a .desktop whose Exec points at the removed binary fails
		// GDesktopAppInfo, so the portal rejects Registry.Register ("App info not found").
		if (existsSync(file) && readFileSync(file, "utf8") === desired) return;
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, desired);
		log.info(`wrote portal .desktop ${color.gray(file)}`);
	} catch (e) {
		log.warn("could not write .desktop for portal registration:", e);
	}
}

// Shared by the portal-trigger and Hyprland-bind formatters below: splits an Electron
// accelerator into its modifier keywords and main key, e.g. "CommandOrControl+Alt+R" →
// mods ["CTRL", "ALT"], key "R".
function splitAccelerator(accelerator: string): { mods: string[]; key: string } | null {
	if (!accelerator) return null;
	const parts = accelerator.split("+");
	const key = parts.pop();
	if (!key) return null;
	const mods = parts.map((m) => {
		switch (m.toLowerCase()) {
			case "commandorcontrol":
			case "cmdorctrl":
			case "control":
			case "ctrl":
			case "command":
			case "cmd":
				return "CTRL";
			case "alt":
			case "option":
				return "ALT";
			case "shift":
				return "SHIFT";
			case "super":
			case "meta":
				return "SUPER";
			default:
				return m.toUpperCase();
		}
	});
	return { mods, key };
}

// Portal trigger string ("CommandOrControl+Alt+R" → "CTRL+ALT+r"). Advisory only
// (Hyprland ignores it), so best-effort is fine.
function toPortalTrigger(accelerator: string): string {
	const split = splitAccelerator(accelerator);
	return split ? [...split.mods, split.key.toLowerCase()].join("+") : "";
}

function startLinuxGlobalShortcuts(): void {
	const ids = Object.keys(HOTKEY_ACTION) as HotkeyId[];
	log.info(`linux global shortcuts: starting (${ids.map((id) => `${id}=${hotkeys[id] || "(unbound)"}`).join(", ")})`);
	let gh: GlobalHotkeyModule;
	try {
		gh = require("@web2d/global-hotkey") as GlobalHotkeyModule;
		log.debug("global-hotkey native module loaded");
	} catch (e) {
		log.warn("global-hotkey native module unavailable; Linux hotkeys disabled:", e);
		return;
	}
	ensureDesktopEntry();
	const shortcuts = ids.map((id) => ({
		id,
		description: HOTKEY_DESCRIPTION[id],
		preferredTrigger: toPortalTrigger(hotkeys[id]),
	}));
	log.info(`registering portal shortcuts ${color.gray(`app=${PORTAL_APP_ID} ids=[${ids.join(", ")}]`)}`);
	try {
		gh.start(PORTAL_APP_ID, shortcuts, (err, id) => {
			if (err) return log.warn("global-hotkey activation error:", err);
			log.info(`global shortcut activated: ${color.cyan(id)}`);
			const shortcutId = id.includes(":") ? (id.split(":").pop() as string) : id;
			const action = HOTKEY_ACTION[shortcutId as HotkeyId];
			if (action) {
				log.debug(`running action for "${shortcutId}"`);
				action();
			} else {
				log.warn(`activated shortcut "${id}" has no action (parsed id "${shortcutId}")`);
			}
		});
		log.ok(`portal global shortcuts registered ${color.gray(`(${ids.map((id) => `${PORTAL_APP_ID}:${id}`).join(", ")})`)}`);
	} catch (e) {
		log.warn("portal global-shortcut registration failed:", e);
		return;
	}

	const autoBind = loadHyprlandAutoBindSync();
	log.info(`hyprlandAutoBind = ${autoBind ? color.green("true") : color.gray("false")}`);
	if (autoBind) {
		for (const id of ids) applyHyprlandBind(id, hotkeys[id]);
	} else {
		log.info(
			color.gray(
				`bind the shortcuts in hyprland.conf (bind = <mods>, <key>, global, ${PORTAL_APP_ID}:<${ids.join("|")}>) or set hyprlandAutoBind = true`,
			),
		);
	}
}

// Hyprland only ignores duplicate binds by stacking them, so we unbind before binding;
// the same combos are unbound on quit. The registered portal shortcut itself lingers in
// `hyprctl globalshortcuts` (XDPH keeps it for the compositor's lifetime) but dedupes.
const hyprlandBoundCombos: Partial<Record<HotkeyId, string>> = {};

function applyHyprlandBind(id: HotkeyId, accelerator: string): void {
	if (!onHyprland()) return; // hyprlandAutoBind is a no-op off a real Hyprland session
	const combo = toHyprlandCombo(accelerator);
	if (!combo) {
		log.warn(`hyprland auto-bind: could not derive a bind combo from "${accelerator}"`);
		return;
	}
	const target = `${PORTAL_APP_ID}:${id}`;
	const previous = hyprlandBoundCombos[id];
	// Drop the old combo (accelerator changed) and any stale/duplicate of the new one
	// before binding, so the compositor doesn't stack duplicate binds.
	if (previous && previous !== combo) hyprSetKeyword("unbind", previous);
	hyprSetKeyword("unbind", combo);
	if (hyprSetKeyword("bind", `${combo}, global, ${target}`)) {
		hyprlandBoundCombos[id] = combo;
		log.ok(`hyprland auto-bind ${color.cyan(`${combo} → ${target}`)}`);
	}
}

// hyprctl bind combo ("CommandOrControl+Alt+R" → "CTRL ALT, R").
function toHyprlandCombo(accelerator: string): string | null {
	const split = splitAccelerator(accelerator);
	return split ? `${split.mods.join(" ")}, ${split.key.toUpperCase()}` : null;
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
	// Rebuild the whole menu so the checkbox repaints: on Linux the SNI/libdbusmenu
	// item doesn't live-update its checkmark when `checked` changes — only a fresh
	// setContextMenu does. (Harmless on macOS; the menu is already closed by click time.)
	refreshTrayMenu();
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
	// The pointer-event path needs no OS/compositor support at all, and startCursorPoll
	// always has a working source now (Hyprland native, or Electron's screen API
	// elsewhere) — so this only needs to reflect the user's config toggle.
	ipcMain.handle("cursor:supported", () => loadCursorLookSync().enabled);
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
		// Wayland has no renderer guide, so the window itself must be natively resizable;
		// macOS/Windows/X11 keep it false so AeroSpace's AX heuristic ignores the overlay
		// (and the guide drives resizing instead).
		resizable: IS_WAYLAND,
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

	// Wayland has no renderer guide; the window is natively resizable, so persist the
	// geometry on resize (debounced) to survive restart. Read it from the compositor,
	// not win.getBounds() — on Wayland Electron's reported position isn't trustworthy.
	if (IS_WAYLAND) {
		win.on("resize", () => {
			const c = overlayHyprlandClient();
			if (c) persistBounds({ x: c.x, y: c.y, width: c.width, height: c.height });
		});
	}
	win.on("closed", stopCursorPoll);

	win.once("ready-to-show", () => {
		win.showInactive(); // show without taking focus
		applyMacOverlay(win);
		setOverlayLock(win, overlayLocked);
		if (IS_WAYLAND) restoreLinuxBounds(); // Wayland ignores the window's creation x/y
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
			{
				label: overlayLocked ? "Unlock (make clickable)" : "Lock (click-through)",
				accelerator: hotkeys.lock || undefined,
				click: toggleLock,
			},
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
				// Drive off our own state, not item.checked — libdbusmenu doesn't reliably
				// pre-flip it on Linux, and setUiToggle rebuilds the menu to repaint anyway.
				click: () => setUiToggle("showFps", !uiToggles.showFps),
			},
			{
				label: "Show expression list",
				type: "checkbox",
				checked: uiToggles.showExpressions,
				click: () => setUiToggle("showExpressions", !uiToggles.showExpressions),
			},
			{ type: "separator" },
			{ label: "Settings…", click: openSettings },
			{ label: "Face tracking debug…", click: openFaceDebug },
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
	if (IS_WAYLAND) {
		Object.assign(hotkeys, saved); // reflect saved accelerators (config:get-hotkey, preferredTrigger)
		startLinuxOverlayRules();
		startLinuxGlobalShortcuts();
	} else {
		for (const id of Object.keys(hotkeys) as HotkeyId[]) {
			if (!applyHotkey(id, saved[id])) {
				log.error(`could not register ${id} hotkey "${saved[id]}" — in use by another app?`);
			}
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
	// Capture the final window geometry from the compositor (Wayland doesn't give it to
	// Electron reliably). Note SIGTERM/SIGINT — how `pnpm dev` stops — skips will-quit;
	// the debounced resize save in createWindow covers the geometry during the session.
	clearTimeout(winSaveTimer);
	stopCursorPoll();
	if (IS_WAYLAND) {
		const c = overlayHyprlandClient();
		if (c) {
			log.info(`saving window bounds ${color.gray(`${c.width}×${c.height} @ (${c.x},${c.y})`)}`);
			saveWindowBoundsSync({ x: c.x, y: c.y, width: c.width, height: c.height });
		}
	}
	globalShortcut.unregisterAll();
	// Best-effort; setKeyword is synchronous so the unbind lands before exit (won't run
	// on SIGKILL — the next launch's unbind-before-bind cleans up a leftover either way).
	for (const combo of Object.values(hyprlandBoundCombos)) {
		if (combo) hyprSetKeyword("unbind", combo);
	}
	// Rules are session-scoped and harmless if left, but undo them anyway (same as binds).
	applyHyprlandRules(clearedRules([...HYPRLAND_BASE_RULES, ...HYPRLAND_LOCK_RULES]));
	tray?.destroy(); // release the menubar icon so it can't linger as a ghost
	tray = null;
	log.info("quit");
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
