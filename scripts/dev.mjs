// Dev orchestrator: build the Electron shell, start the Vite dev server, wait
// for it, then launch Electron pointed at it. Kills the dev server on exit.
//
//   node scripts/dev.mjs          normal dev (NODE_ENV=development)
//   node scripts/dev.mjs --perf   NODE_ENV=production + Metal/GPU flags (macOS)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnElectronFiltered, installCleanup } from "./spawn-electron.mjs";

const PORT = 1420;
const URL = `http://localhost:${PORT}`;
const PERF = process.argv.includes("--perf");

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

const { cleanup, track } = installCleanup();
track(vite);

// If Vite dies on its own, don't leave Electron pointed at a dead server.
vite.on("exit", () => {
	cleanup();
	process.exit(0);
});

// 3. Wait for it, then launch Electron.
await waitForServer(URL);

// --perf: NODE_ENV=production removes Pixi/framework debug paths; --use-angle=metal
// switches WebGL to the Metal backend on macOS (lower driver overhead than ANGLE/GL).
const perfArgs = PERF
	? ["--use-angle=metal", "--enable-gpu-rasterization", "--enable-zero-copy"]
	: [];
const perfEnv = PERF ? { NODE_ENV: "production" } : {};

// ELECTRON_OZONE_PLATFORM_HINT is read earlier than the in-app commandLine switch, so
// set it here too to get the native Wayland backend (correct devicePixelRatio).
const electron = spawnElectronFiltered([...perfArgs, "."], {
	...process.env,
	...perfEnv,
	ELECTRON_RENDERER_URL: URL,
	ELECTRON_OZONE_PLATFORM_HINT: "auto",
});
track(electron);

electron.on("exit", () => {
	cleanup();
	process.exit(0);
});
