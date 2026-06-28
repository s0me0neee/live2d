import type { WebContents } from "electron";

// blink::mojom::ConsoleMessageLevel order (Electron's console-message `level`).
const LEVEL_LABEL = ["VERBOSE", "INFO", "WARN", "ERROR"];

// Mirror a renderer's console output (logs, warnings, errors) to the main process's
// stdout so it shows in the terminal — by default it only reaches the devtools.
export function forwardConsole(wc: WebContents, tag: string): void {
	wc.on("console-message", (_e, level, message, line, sourceId) => {
		const label = LEVEL_LABEL[level] ?? "LOG";
		const where = sourceId ? ` (${sourceId}:${line})` : "";
		process.stdout.write(`[${tag}:${label}] ${message}${where}\n`);
	});
}
