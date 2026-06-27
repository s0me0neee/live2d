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
	// objc_msgSend is variadic in C; each selector signature gets its own typed
	// wrapper around the same symbol (koffi allows redeclaring it).
	sendId: (self: unknown, sel: unknown) => unknown;
	sendVoid: (self: unknown, sel: unknown) => void;
	sendLong: (self: unknown, sel: unknown, arg: number) => void;
	sendULong: (self: unknown, sel: unknown, arg: number) => void;
	sendBool: (self: unknown, sel: unknown, arg: boolean) => void;
}

let bridge: ObjcBridge | null = null;
let bridgeFailed = false;

function objc(): ObjcBridge | null {
	if (bridge) return bridge;
	if (bridgeFailed || !isMac) return null;
	try {
		const lib = koffi.load("/usr/lib/libobjc.A.dylib");
		const selReg = lib.func("sel_registerName", "void *", ["str"]);
		bridge = {
			sel: (name: string) => selReg(name),
			sendId: lib.func("objc_msgSend", "void *", ["void *", "void *"]),
			sendVoid: lib.func("objc_msgSend", "void", ["void *", "void *"]),
			sendLong: lib.func("objc_msgSend", "void", ["void *", "void *", "long"]),
			sendULong: lib.func("objc_msgSend", "void", ["void *", "void *", "unsigned long"]),
			sendBool: lib.func("objc_msgSend", "void", ["void *", "void *", "bool"]),
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
 * Read back the NSWindow level — used by the smoke test to confirm the native
 * call actually took effect. Returns null if AppKit is unavailable.
 */
export function readMacWindowLevel(win: BrowserWindow): number | null {
	const o = objc();
	if (!o || win.isDestroyed()) return null;
	const nsWindow = nsWindowOf(win, o);
	if (!nsWindow) return null;
	const lib = koffi.load("/usr/lib/libobjc.A.dylib");
	const levelGetter = lib.func("objc_msgSend", "long", ["void *", "void *"]);
	return levelGetter(nsWindow, o.sel("level")) as number;
}
