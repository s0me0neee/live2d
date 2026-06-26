import { app, BrowserWindow, ipcMain, session } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
// __dirname is a native global in the bundled CommonJS output (dist-electron/).

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
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Float above normal windows (taskbars/fullscreen apps too).
	win.setAlwaysOnTop(true, "screen-saver");

	if (DEV_URL) {
		win.loadURL(DEV_URL);
	} else {
		win.loadFile(join(__dirname, "../dist/index.html"));
	}
}

app.whenReady().then(() => {
	// Auto-grant the webcam (face tracking) — same trust model as the Tauri app.
	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
		cb(permission === "media");
	});

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
