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
import { spawnElectronFiltered, installCleanup } from "./spawn-electron.mjs";

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

// Asset caveat: /model and /mediapipe are dev-only (served from the project root by
// Vite, not in `vite build` output). Ship them as electron-builder `extraResources`
// and resolve via process.resourcesPath in production — verify before trusting a build.

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
	const { cleanup, track } = installCleanup();
	// Deliberately NOT setting ELECTRON_RENDERER_URL: its absence is what makes main.ts
	// take the production (load-from-disk) branch.
	const electron = spawnElectronFiltered(["."], {
		...ENV,
		ELECTRON_OZONE_PLATFORM_HINT: "auto", // native Wayland backend, same reason dev sets it
	});
	track(electron);

	electron.on("exit", (code) => {
		cleanup();
		process.exit(code ?? 0);
	});
}
