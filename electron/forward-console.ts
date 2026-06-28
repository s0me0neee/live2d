import type { WebContents } from "electron";
import pc from "picocolors";

// Electron 42's console-message `details.level` is a string: verbose|info|warning|error.
const LEVEL: Record<string, { label: string; color: (s: string) => string; stream: NodeJS.WriteStream }> = {
	verbose: { label: "VERB", color: pc.gray, stream: process.stdout },
	info: { label: "INFO", color: pc.cyan, stream: process.stdout },
	warning: { label: "WARN", color: pc.yellow, stream: process.stderr },
	error: { label: "ERR ", color: pc.red, stream: process.stderr },
};

const timestamp = () => pc.gray(new Date().toTimeString().slice(0, 8));

// Mirror a renderer's console output (logs, warnings, errors) to the main process's
// stdout/stderr so it shows in the terminal — by default it only reaches devtools.
export function forwardConsole(wc: WebContents, tag: string): void {
	const coloredTag = pc.magenta(pc.bold(`[${tag}]`));
	wc.on("console-message", (details) => {
		const lvl = LEVEL[details.level] ?? LEVEL.info;
		const where = details.sourceId ? pc.gray(` (${details.sourceId}:${details.lineNumber})`) : "";
		lvl.stream.write(`${timestamp()} ${lvl.color(lvl.label)} ${coloredTag} ${details.message}${where}\n`);
	});
}
