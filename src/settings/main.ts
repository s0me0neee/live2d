const api = window.electronAPI;
const recordBtn = document.getElementById("record") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

let recording = false;

init();

async function init(): Promise<void> {
	if (!api?.hotkey) {
		recordBtn.textContent = "unavailable";
		recordBtn.disabled = true;
		return;
	}
	recordBtn.textContent = await api.hotkey.get();
	recordBtn.addEventListener("click", startRecording);
	window.addEventListener("keydown", onKeyDown);
}

function startRecording(): void {
	recording = true;
	recordBtn.classList.add("recording");
	recordBtn.textContent = "press keys…";
	setStatus("", false);
}

async function onKeyDown(e: KeyboardEvent): Promise<void> {
	if (!recording) return;
	e.preventDefault();
	const accelerator = toAccelerator(e);
	if (!accelerator) return; // a bare modifier — keep waiting for the main key

	recording = false;
	recordBtn.classList.remove("recording");

	const ok = await api!.hotkey.set(accelerator);
	recordBtn.textContent = ok ? accelerator : await api!.hotkey.get();
	setStatus(ok ? "Saved." : `${accelerator} is unavailable — try another.`, !ok);
}

function setStatus(text: string, isError: boolean): void {
	statusEl.textContent = text;
	statusEl.classList.toggle("error", isError);
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
