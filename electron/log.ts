import { format } from "node:util";
import pc from "picocolors";

// Structured, colored logging for the main process. picocolors auto-detects color
// support (TTY + NO_COLOR / FORCE_COLOR), so piping the output to a file stays plain.

// A fixed-width, colored badge per level so columns line up in the terminal. warn/
// error go to stderr (which dev.mjs pipes through), the rest to stdout.
const LEVEL = {
	debug: { badge: pc.gray("DBG"), stream: process.stdout },
	info: { badge: pc.cyan("INF"), stream: process.stdout },
	ok: { badge: pc.green("OK "), stream: process.stdout },
	warn: { badge: pc.yellow("WRN"), stream: process.stderr },
	error: { badge: pc.red("ERR"), stream: process.stderr },
} satisfies Record<string, { badge: string; stream: NodeJS.WriteStream }>;

const TAG_COLORS = [pc.cyan, pc.magenta, pc.blue, pc.green, pc.yellow];
function tagColor(tag: string): (s: string) => string {
	let h = 0;
	for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
	return TAG_COLORS[h % TAG_COLORS.length];
}

const timestamp = () => pc.gray(new Date().toTimeString().slice(0, 8));

// If the launching terminal dies, the app survives orphaned with a dead stdout;
// without an error listener the next write raises EIO/EPIPE as an uncaught
// exception (crash dialog from e.g. the lock hotkey's log line). Swallow it —
// logging must never take the overlay down.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

function emit(level: keyof typeof LEVEL, coloredTag: string, args: unknown[]): void {
	const { badge, stream } = LEVEL[level];
	try {
		stream.write(`${timestamp()} ${badge} ${coloredTag} ${format(...args)}\n`);
	} catch {
		// a destroyed stream throws synchronously
	}
}

export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	ok(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
	const coloredTag = tagColor(tag)(pc.bold(`[${tag}]`));
	return {
		debug: (...a) => emit("debug", coloredTag, a),
		info: (...a) => emit("info", coloredTag, a),
		ok: (...a) => emit("ok", coloredTag, a),
		warn: (...a) => emit("warn", coloredTag, a),
		error: (...a) => emit("error", coloredTag, a),
	};
}

// Re-export so callers can accent part of a message without importing picocolors.
export { default as color } from "picocolors";
