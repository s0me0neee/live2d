// Shared by dev.mjs and release.mjs's --preview: spawn Electron with its stderr noise
// filtered, and the idempotent child-teardown both scripts need.
import { spawn } from "node:child_process";

const NOISE = /Fontconfig warning|wayland_event_watcher|libwayland:/;

// Spawns `pnpm exec electron <args>`, dropping the noisy boot/teardown lines (system
// fontconfig warnings + Chromium's wayland teardown spam) from stderr so the app's own
// logs stay visible.
export function spawnElectronFiltered(args, env) {
	const electron = spawn("pnpm", ["exec", "electron", ...args], {
		stdio: ["inherit", "inherit", "pipe"],
		env,
	});

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
	});

	return electron;
}

// Kills every tracked child at most once, on process exit or an explicit Ctrl-C/TERM —
// otherwise terminating the orchestrator leaves an orphaned Electron app (and webcam)
// running. `track` can be called after the fact, once a child is spawned.
export function installCleanup() {
	const children = [];
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		for (const child of children) if (child && !child.killed) child.kill();
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => process.exit(0));
	process.on("SIGTERM", () => process.exit(0));
	return { cleanup, track: (child) => children.push(child) };
}
