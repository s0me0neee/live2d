// scripts/release.mjs
//
// Production counterpart to the dev orchestrator. Unlike dev, the release flow
// is a linear pipeline — build the pieces, then package — so there's nothing to
// babysit except in --preview mode, where we reuse the dev script's child
// teardown + log filtering.
//
//   node scripts/release.mjs            build + package installers for this platform
//   node scripts/release.mjs --dir      build + package UNPACKED only (fast smoke test)
//   node scripts/release.mjs --preview  build prod, then run it locally (no packaging)

import { spawn } from "node:child_process";

const args = new Set(process.argv.slice(2));
const PREVIEW = args.has("--preview");
const DIR_ONLY = args.has("--dir");

// Production for every child: flips NODE_ENV-gated dead code (framework dev
// warnings, asserts) and is the signal build-electron.mjs / vite use to minify.
const ENV = { ...process.env, NODE_ENV: "production" };

function run(cmd, cmdArgs, opts = {}) {
	return new Promise((res, rej) => {
		const p = spawn(cmd, cmdArgs, { stdio: "inherit", env: ENV, ...opts });
		p.on("exit", (code) =>
			code === 0 ? res() : rej(new Error(`${cmd} ${cmdArgs.join(" ")} exited ${code}`)),
		);
	});
}

// 1. Main + preload, production build. Assumes build-electron.mjs honors
//    NODE_ENV (minify, drop sourcemaps when "production"). If it doesn't yet,
//    that's the one-line change to make on its side — the script can't enforce it.
await run("node", ["scripts/build-electron.mjs"]);

// 2. Renderer. `vite build` is production by default; passing --mode explicitly
//    documents intent and is immune to a stray --mode override in the config.
await run("pnpm", ["exec", "vite", "build", "--mode", "production"]);

// --- ASSET CAVEAT ------------------------------------------------------------
// In dev, /model and /mediapipe are served from the project root by Vite. They
// are NOT in `vite build` output unless they live in `public/` or are imported.
// For the packaged app you almost certainly want them shipped as
// electron-builder `extraResources` (so the 4×4096² Live2D atlases + mediapipe
// wasm are copied verbatim, not run through Rollup), with main.ts resolving them
// via process.resourcesPath in production. Verify this before trusting a build —
// it's the most likely thing to "work in dev, blank screen when packaged."
// -----------------------------------------------------------------------------

if (PREVIEW) {
	previewProductionBuild();
} else {
	// 3. Package. electron-builder is the assumption here; swap this single line
	//    for forge / @electron/packager if that's your toolchain. --dir skips
	//    installer generation and just produces the unpacked app dir.
	const builderArgs = ["exec", "electron-builder", ...(DIR_ONLY ? ["--dir"] : [])];
	await run("pnpm", builderArgs);
	console.log(`\n✓ release ${DIR_ONLY ? "(unpacked)" : "(packaged)"} complete`);
}

// Launch the just-built app the way it runs in production: no ELECTRON_RENDERER_URL,
// so main.ts loads the built index.html off disk instead of the dev server. This
// is the real smoke test — it catches file:// path bugs, missing extraResources,
// and NODE_ENV-only regressions that the dev server never surfaces.
function previewProductionBuild() {
	const electron = spawn("pnpm", ["exec", "electron", "."], {
		stdio: ["inherit", "inherit", "pipe"],
		env: {
			...ENV,
			// Native Wayland backend for correct devicePixelRatio — same reason dev sets it.
			ELECTRON_OZONE_PLATFORM_HINT: "auto",
			// Deliberately NOT setting ELECTRON_RENDERER_URL: its absence is what
			// makes main.ts take the production (load-from-disk) branch.
		},
	});

	// Same boot/teardown noise filter as dev so the app's own logs stay visible.
	const NOISE = /Fontconfig warning|wayland_event_watcher|libwayland:/;
	let buf = "";
	electron.stderr.on("data", (chunk) => {
		buf += chunk;
		const lines = buf.split("\n");
		buf = lines.pop() ?? ""; // keep trailing partial line for next chunk
		for (const line of lines) {
			if (!NOISE.test(line)) process.stderr.write(line + "\n");
		}
	});

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (!electron.killed) electron.kill();
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => process.exit(0));
	process.on("SIGTERM", () => process.exit(0));

	electron.on("exit", (code) => {
		if (buf && !NOISE.test(buf)) process.stderr.write(buf);
		cleanup();
		process.exit(code ?? 0);
	});
}
