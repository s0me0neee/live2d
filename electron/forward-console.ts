import type { WebContents } from "electron";

// Mirror a renderer's console output (logs, warnings, errors) to the main process's
// stdout so it shows in the terminal — by default it only reaches the devtools.
export function forwardConsole(wc: WebContents, tag: string): void {
	wc.on("console-message", (details) => {
		const label = details.level.toUpperCase();
		const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : "";
		process.stdout.write(`[${tag}:${label}] ${details.message}${where}\n`);
	});
}
