// Dev orchestrator: build the Electron shell, start the Vite dev server, wait
// for it, then launch Electron pointed at it. Kills the dev server on exit.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 1420;
const URL = `http://localhost:${PORT}`;

async function run(cmd, args, opts = {}) {
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { stdio: "inherit", ...opts });
		p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
	});
}

async function waitForServer(url, tries = 100) {
	for (let i = 0; i < tries; i++) {
		try {
			await fetch(url);
			return;
		} catch {
			await sleep(150);
		}
	}
	throw new Error(`dev server never came up at ${url}`);
}

// 1. Build main/preload once so Electron has something to load.
await run("node", ["scripts/build-electron.mjs"]);

// 2. Vite dev server (serves the renderer + project-root assets: /model, /mediapipe).
const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
	stdio: "inherit",
});

// Spawned below; declared here so cleanup can reach it. Both children must be
// killed on exit — otherwise terminating the orchestrator (SIGTERM from an IDE,
// a Vite crash) leaves an orphaned Electron app (and webcam) running.
let electron = null;
let cleaned = false;
const cleanup = () => {
	if (cleaned) return; // kill() is idempotent but guard the double-signal path
	cleaned = true;
	if (!vite.killed) vite.kill();
	if (electron && !electron.killed) electron.kill();
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// If Vite dies on its own, don't leave Electron pointed at a dead server.
vite.on("exit", () => {
	cleanup();
	process.exit(0);
});

// 3. Wait for it, then launch Electron.
await waitForServer(URL);
electron = spawn("pnpm", ["exec", "electron", "."], {
	// pipe stderr so we can drop the harmless boot/teardown spam (system
	// fontconfig "invalid constant" warnings + Chromium's wayland teardown
	// lines) that would otherwise bury the app's own logs.
	stdio: ["inherit", "inherit", "pipe"],
	// ELECTRON_OZONE_PLATFORM_HINT is read earlier than the in-app commandLine switch,
	// so set it here too to get the native Wayland backend (correct devicePixelRatio).
	env: { ...process.env, ELECTRON_RENDERER_URL: URL, ELECTRON_OZONE_PLATFORM_HINT: "auto" },
});

const NOISE = /Fontconfig warning|wayland_event_watcher|libwayland:/;
let buf = "";
electron.stderr.on("data", (chunk) => {
	buf += chunk;
	const lines = buf.split("\n");
	buf = lines.pop() ?? ""; // keep the trailing partial line for next chunk
	for (const line of lines) {
		if (!NOISE.test(line)) process.stderr.write(line + "\n");
	}
});

electron.on("exit", () => {
	if (buf && !NOISE.test(buf)) process.stderr.write(buf);
	cleanup();
	process.exit(0);
});
