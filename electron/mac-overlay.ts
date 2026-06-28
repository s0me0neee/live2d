// Raw AppKit overlay tweaks for macOS, applied to the live BrowserWindow through
// the Objective-C runtime via FFI (koffi). This mirrors what DmNote does in
// native Rust (`apply_macos_overlay_fullscreen_behavior`): lift the NSWindow to
// the status level, let it join every Space and float over fullscreen apps, and
// stop it hiding when the app deactivates.
//
// koffi is a native CommonJS addon; esbuild keeps it external (see
// scripts/build-electron.mjs) so its prebuilt .node resolves at runtime.
import koffi from "koffi";
import type { BrowserWindow } from "electron";

const isMac = process.platform === "darwin";

// NSWindowLevel — NSStatusWindowLevel (25) floats above normal and floating
// windows but below the screensaver/notification shade, the exact level DmNote
// chooses so the overlay covers games without burying system UI.
const NS_STATUS_WINDOW_LEVEL = 25;

// NSWindowCollectionBehavior bits (<AppKit/NSWindow.h>):
//   canJoinAllSpaces    = 1 << 0  → visible on every Space / virtual desktop
//   fullScreenAuxiliary = 1 << 8  → stays up while another app is fullscreen
const COLLECTION_BEHAVIOR = (1 << 0) | (1 << 8);

interface ObjcBridge {
	sel: (name: string) => unknown;
	getClass: (name: string) => unknown;
	// objc_msgSend is variadic in C; each selector signature gets its own typed
	// wrapper around the same symbol (koffi allows redeclaring it).
	sendId: (self: unknown, sel: unknown) => unknown;
	sendIdLong: (self: unknown, sel: unknown, arg: number) => unknown;
	sendVoid: (self: unknown, sel: unknown) => void;
	sendLong: (self: unknown, sel: unknown, arg: number) => void;
	sendULong: (self: unknown, sel: unknown, arg: number) => void;
	sendBool: (self: unknown, sel: unknown, arg: boolean) => void;
	// objc_msgSend typed to return `long` — for reading scalar getters (e.g. level).
	sendRetLong: (self: unknown, sel: unknown) => number;
}

let bridge: ObjcBridge | null = null;
let bridgeFailed = false;

function objc(): ObjcBridge | null {
	if (bridge) return bridge;
	if (bridgeFailed || !isMac) return null;
	try {
		const lib = koffi.load("/usr/lib/libobjc.A.dylib");
		const selReg = lib.func("sel_registerName", "void *", ["str"]);
		const getCls = lib.func("objc_getClass", "void *", ["str"]);
		bridge = {
			sel: (name: string) => selReg(name),
			getClass: (name: string) => getCls(name),
			sendId: lib.func("objc_msgSend", "void *", ["void *", "void *"]),
			sendIdLong: lib.func("objc_msgSend", "void *", ["void *", "void *", "long"]),
			sendVoid: lib.func("objc_msgSend", "void", ["void *", "void *"]),
			sendLong: lib.func("objc_msgSend", "void", ["void *", "void *", "long"]),
			sendULong: lib.func("objc_msgSend", "void", ["void *", "void *", "unsigned long"]),
			sendBool: lib.func("objc_msgSend", "void", ["void *", "void *", "bool"]),
			sendRetLong: lib.func("objc_msgSend", "long", ["void *", "void *"]) as (
				self: unknown,
				sel: unknown,
			) => number,
		};
		return bridge;
	} catch (err) {
		bridgeFailed = true;
		console.warn("[overlay] AppKit FFI unavailable, skipping native tweaks:", err);
		return null;
	}
}

// getNativeWindowHandle() returns a Buffer holding the NSView* of the window's
// content view; -[NSView window] then gives us the owning NSWindow.
function nsWindowOf(win: BrowserWindow, o: ObjcBridge): unknown | null {
	const nsView = koffi.decode(win.getNativeWindowHandle(), "void *");
	if (!nsView) return null;
	const nsWindow = o.sendId(nsView, o.sel("window"));
	return nsWindow || null;
}

/**
 * Apply (or re-apply) the AppKit overlay behavior to `win`. Safe to call
 * repeatedly — DmNote re-applies on focus loss / show, and so do we, because
 * AppKit can reset the level when the window is reordered.
 *
 * No-op on non-macOS platforms or if the FFI bridge can't be loaded.
 */
export function applyMacOverlay(win: BrowserWindow): void {
	const o = objc();
	if (!o || win.isDestroyed()) return;
	const nsWindow = nsWindowOf(win, o);
	if (!nsWindow) return;

	o.sendLong(nsWindow, o.sel("setLevel:"), NS_STATUS_WINDOW_LEVEL);
	o.sendULong(nsWindow, o.sel("setCollectionBehavior:"), COLLECTION_BEHAVIOR);
	o.sendBool(nsWindow, o.sel("setHidesOnDeactivate:"), false);
	// Bring it forward without making it key/main (won't steal focus).
	o.sendVoid(nsWindow, o.sel("orderFrontRegardless"));
}

/**
 * Re-assert just the window-server state (level + all-Spaces collection behavior +
 * no-hide), without re-ordering the window. A programmatic setBounds makes AppKit
 * drop canJoinAllSpaces, and the AeroSpace WM grabs the window in the gap before the
 * async `move` event fires — so call this SYNCHRONOUSLY right after setBounds to keep
 * the overlay continuously unmanaged. Cheaper than applyMacOverlay (no orderFront),
 * so it's fine to run on every drag frame.
 */
export function reassertOverlayState(win: BrowserWindow): void {
	const o = objc();
	if (!o || win.isDestroyed()) return;
	const nsWindow = nsWindowOf(win, o);
	if (!nsWindow) return;

	o.sendLong(nsWindow, o.sel("setLevel:"), NS_STATUS_WINDOW_LEVEL);
	o.sendULong(nsWindow, o.sel("setCollectionBehavior:"), COLLECTION_BEHAVIOR);
	o.sendBool(nsWindow, o.sel("setHidesOnDeactivate:"), false);
}

/**
 * Read back the NSWindow level — used by the smoke test to confirm the native
 * call actually took effect. Returns null if AppKit is unavailable.
 */
export function readMacWindowLevel(win: BrowserWindow): number | null {
	const o = objc();
	if (!o || win.isDestroyed()) return null;
	const nsWindow = nsWindowOf(win, o);
	if (!nsWindow) return null;
	return o.sendRetLong(nsWindow, o.sel("level"));
}

// NSApplicationActivationPolicy: 0 = regular, 1 = accessory, 2 = prohibited.
// AeroSpace only ignores a (close-button-less) window while its app is accessory(1).
export function readActivationPolicy(): number | null {
	const o = objc();
	if (!o) return null;
	const nsApp = o.sendId(o.getClass("NSApplication"), o.sel("sharedApplication"));
	if (!nsApp) return null;
	return o.sendRetLong(nsApp, o.sel("activationPolicy"));
}

// Remove the standard window buttons (close/miniaturize/zoom) from the NSWindow.
// Electron keeps them on the NSWindow even when frameless, and their presence makes
// the AeroSpace WM treat the (otherwise accessory-app) overlay as a real, manageable
// window — it tiles it once a move makes it re-evaluate. Removing them clears the AX
// close-button attribute AeroSpace's isWindowHeuristic checks.
export function removeWindowButtons(win: BrowserWindow): void {
	const o = objc();
	if (!o || win.isDestroyed()) return;
	const nsWindow = nsWindowOf(win, o);
	if (!nsWindow) return;

	for (const buttonType of [0, 1, 2]) {
		const button = o.sendIdLong(nsWindow, o.sel("standardWindowButton:"), buttonType);
		if (button) o.sendVoid(button, o.sel("removeFromSuperview"));
	}
}
