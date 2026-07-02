import type { HotkeyId } from "../config";

const api = window.electronAPI;

const hotkeyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-hotkey]"));

let recording: { id: HotkeyId; btn: HTMLButtonElement } | null = null;

init();

async function init(): Promise<void> {
	if (!api?.hotkey) {
		for (const btn of hotkeyButtons) {
			btn.textContent = "unavailable";
			btn.disabled = true;
		}
		return;
	}
	for (const btn of hotkeyButtons) {
		const id = btn.dataset.hotkey as HotkeyId;
		btn.textContent = label(await api.hotkey.get(id));
		btn.addEventListener("click", () => startRecording(id, btn));
	}
	for (const clr of document.querySelectorAll<HTMLButtonElement>("[data-clear]")) {
		clr.addEventListener("click", () => clearHotkey(clr.dataset.clear as HotkeyId));
	}
	window.addEventListener("keydown", onKeyDown);
}

const label = (accelerator: string): string => accelerator || "none";

function buttonFor(id: HotkeyId): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-hotkey="${id}"]`)!;
}

type StatusKind = "info" | "ok" | "error";

function setStatus(id: HotkeyId, text: string, kind: StatusKind = "info"): void {
	const el = document.querySelector<HTMLDivElement>(`[data-status="${id}"]`)!;
	el.textContent = text;
	el.classList.toggle("ok", kind === "ok");
	el.classList.toggle("error", kind === "error");
}

function startRecording(id: HotkeyId, btn: HTMLButtonElement): void {
	if (recording) recording.btn.classList.remove("recording");
	recording = { id, btn };
	btn.classList.add("recording");
	btn.textContent = "press keys…";
	setStatus(id, "Listening…");
}

function stopRecording(): void {
	recording?.btn.classList.remove("recording");
	recording = null;
}

async function clearHotkey(id: HotkeyId): Promise<void> {
	const ok = await api!.hotkey.set(id, "");
	buttonFor(id).textContent = ok ? "none" : label(await api!.hotkey.get(id));
	setStatus(id, ok ? "Unbound." : "Failed to unbind.", ok ? "ok" : "error");
}

async function onKeyDown(e: KeyboardEvent): Promise<void> {
	if (!recording) return;
	e.preventDefault();
	const { id, btn } = recording;

	if (e.code === "Escape") {
		stopRecording();
		btn.textContent = label(await api!.hotkey.get(id));
		setStatus(id, "");
		return;
	}
	if (e.code === "Backspace" || e.code === "Delete") {
		stopRecording();
		await clearHotkey(id);
		return;
	}

	const accelerator = toAccelerator(e);
	if (!accelerator) return; // a bare modifier — keep waiting for the main key

	stopRecording();
	const ok = await api!.hotkey.set(id, accelerator);
	btn.textContent = ok ? accelerator : label(await api!.hotkey.get(id));
	setStatus(id, ok ? "Saved." : `${accelerator} is unavailable — try another.`, ok ? "ok" : "error");
}

// Electron global shortcuts need at least one modifier, so a bare key returns null.
function toAccelerator(e: KeyboardEvent): string | null {
	const mods: string[] = [];
	if (e.metaKey) mods.push("Command");
	if (e.ctrlKey) mods.push("Control");
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");

	const key = mainKey(e.code);
	if (!key || !mods.length) return null;
	return [...mods, key].join("+");
}

function mainKey(code: string): string | null {
	if (code.startsWith("Key")) return code.slice(3);
	if (code.startsWith("Digit")) return code.slice(5);
	if (/^F\d{1,2}$/.test(code)) return code;
	return PUNCTUATION[code] ?? null;
}

const PUNCTUATION: Record<string, string> = {
	Space: "Space",
	Enter: "Return",
	Tab: "Tab",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backslash: "\\",
	Backquote: "`",
};
