import type { Config, HotkeyId, ModelConfig } from "../config";
import { LINUX_FIELDS, SECTIONS, isEditPending, renderNumberRow, renderSection, type FieldCommitters } from "./fields";

const api = window.electronAPI;

const commit: FieldCommitters = {
	updateConfig: (patch) => void api?.config.update(patch),
	setUiToggle: (key, value) => void api?.ui.set(key, value),
};

init();

async function init(): Promise<void> {
	if (!api) {
		document.querySelector("main")!.textContent =
			"electronAPI unavailable — open this window from the app, not a browser.";
		return;
	}

	const resolved = await api.getConfig();

	renderSections(resolved.config);
	renderLinux(resolved.config);
	await renderModelPicker(resolved.modelName);
	renderGain(resolved.modelName, resolved.model);
	renderExpressions(resolved.modelName, resolved.model);
	initOverlayControls();
	initHotkeys();
	initUiToggleSync();

	api.config.onChanged((cfg) => {
		renderSections(cfg.config);
		renderLinux(cfg.config);
		void renderModelPicker(cfg.modelName);
		renderGain(cfg.modelName, cfg.model);
		renderExpressions(cfg.modelName, cfg.model);
	});
}

// showFps/showExpressions route through the tray's own toggle (electron/main.ts's
// setUiToggle), which pushes ui:show-fps/ui:show-expressions to both windows rather than
// a config:changed broadcast — so this window's Display-section checkboxes need their own
// listener to stay in sync when the tray (not this window) flips one of them.
function initUiToggleSync(): void {
	api!.ui.onShowFps((v) => syncBoolField(["showFps"], v));
	api!.ui.onShowExpressions((v) => syncBoolField(["showExpressions"], v));
}

function syncBoolField(path: string[], value: boolean): void {
	const input = document.querySelector<HTMLInputElement>(`input[data-path="${path.join(".")}"]`);
	if (input && document.activeElement !== input) input.checked = value;
}

function renderSections(config: Config): void {
	for (const section of SECTIONS) {
		const container = document.getElementById(`fields-${section.id}`);
		if (container) renderSection(container, section.fields, config, commit);
	}
}

function renderLinux(config: Config): void {
	const card = document.getElementById("linux-card");
	const container = document.getElementById("fields-linux");
	if (!card || !container) return;
	if (api!.platform !== "linux") {
		card.style.display = "none";
		return;
	}
	card.style.display = "";
	renderSection(container, LINUX_FIELDS, config, commit);
}

// Reopening the dropdown mid-edit would cancel the user's own in-progress selection, so
// this skips its rebuild the same way renderSection does for its fields.
let modelChangeBound = false;
async function renderModelPicker(activeName: string): Promise<void> {
	const select = document.getElementById("model-select") as HTMLSelectElement | null;
	if (!select || document.activeElement === select) return;

	const names = await api!.config.listModels();
	select.innerHTML = "";
	for (const name of names) {
		const opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		opt.selected = name === activeName;
		select.appendChild(opt);
	}
	if (!names.includes(activeName)) {
		const opt = document.createElement("option");
		opt.value = activeName;
		opt.textContent = activeName ? `${activeName} (missing)` : "(none configured)";
		opt.selected = true;
		select.appendChild(opt);
	}

	if (!modelChangeBound) {
		modelChangeBound = true;
		select.addEventListener("change", async () => {
			const name = select.value;
			setModelStatus(`Switching to "${name}"…`);
			try {
				await api!.config.setModel(name);
				setModelStatus("Switched.", "ok");
			} catch (err) {
				setModelStatus("Failed to switch model.", "error");
				console.error("[settings] setModel failed:", err);
			}
		});
	}
}

type StatusKind = "info" | "ok" | "error";

function setModelStatus(text: string, kind: StatusKind = "info"): void {
	const el = document.getElementById("model-status");
	if (!el) return;
	el.textContent = text;
	el.classList.toggle("ok", kind === "ok");
	el.classList.toggle("error", kind === "error");
}

async function initOverlayControls(): Promise<void> {
	const lockToggle = document.getElementById("lock-toggle") as HTMLInputElement | null;
	if (lockToggle) {
		lockToggle.checked = await api!.overlay.getLock();
		lockToggle.addEventListener("change", () => void api!.overlay.setLock(lockToggle.checked));
		api!.overlay.onLockChanged((locked) => {
			lockToggle.checked = locked;
		});
	}
	document.getElementById("recenter-btn")?.addEventListener("click", () => void api!.faceTracking.recenter());
}

// Per-model physics-derived gain multipliers (discovered from the model's own
// physics3.json — see electron/config.ts's discoverGain). Not part of SECTIONS: these
// keys are model-specific, not fixed Config fields. modelName pins each edit to the
// model it was made against — see electron/config.ts's setGain.
function renderGain(modelName: string, model: ModelConfig): void {
	const container = document.getElementById("gain-fields");
	if (!container || isEditPending() || container.contains(document.activeElement)) return;
	container.innerHTML = "";

	const names = Object.keys(model.gain).sort();
	if (!names.length) {
		container.innerHTML = `<div class="empty">No physics-derived gain settings for this model.</div>`;
		return;
	}
	for (const name of names) {
		renderNumberRow(container, {
			label: name,
			min: 0,
			max: 3,
			step: 0.05,
			value: model.gain[name].value,
			onCommit: (v) => void api!.config.setGain(modelName, name, v),
		});
	}
}

function renderExpressions(modelName: string, model: ModelConfig): void {
	const container = document.getElementById("expr-fields");
	if (!container || isEditPending() || container.contains(document.activeElement)) return;
	container.innerHTML = "";

	const names = Object.keys(model.expressions).sort();
	if (!names.length) {
		container.innerHTML = `<div class="empty">No expressions found for this model.</div>`;
		return;
	}
	for (const name of names) {
		const e = model.expressions[name];
		const row = document.createElement("label");
		row.className = "expr-row";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = e.active;
		cb.addEventListener("change", () => void api!.setExpression(modelName, name, cb.checked));
		const text = document.createElement("span");
		text.textContent = e.key ? `${name} (${e.key})` : name;
		row.append(cb, text);
		container.appendChild(row);
	}
}

// --- Global shortcuts (lock / recenter) ---

const hotkeyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-hotkey]"));

let recording: { id: HotkeyId; btn: HTMLButtonElement } | null = null;

function initHotkeys(): void {
	if (!api?.hotkey) {
		for (const btn of hotkeyButtons) {
			btn.textContent = "unavailable";
			btn.disabled = true;
		}
		return;
	}
	for (const btn of hotkeyButtons) {
		const id = btn.dataset.hotkey as HotkeyId;
		api.hotkey.get(id).then((accelerator) => (btn.textContent = hotkeyLabel(accelerator)));
		btn.addEventListener("click", () => startRecording(id, btn));
	}
	for (const clr of document.querySelectorAll<HTMLButtonElement>("[data-clear]")) {
		clr.addEventListener("click", () => clearHotkey(clr.dataset.clear as HotkeyId));
	}
	window.addEventListener("keydown", onHotkeyKeyDown);
}

const hotkeyLabel = (accelerator: string): string => accelerator || "none";

function hotkeyButton(id: HotkeyId): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-hotkey="${id}"]`)!;
}

function setHotkeyStatus(id: HotkeyId, text: string, kind: StatusKind = "info"): void {
	const el = document.querySelector<HTMLDivElement>(`[data-status="${id}"]`)!;
	el.textContent = text;
	el.classList.toggle("ok", kind === "ok");
	el.classList.toggle("error", kind === "error");
}

function startRecording(id: HotkeyId, btn: HTMLButtonElement): void {
	if (recording) {
		recording.btn.classList.remove("recording");
		void restoreHotkeyButton(recording.id, recording.btn);
	}
	recording = { id, btn };
	btn.classList.add("recording");
	btn.textContent = "press keys…";
	setHotkeyStatus(id, "Listening…");
}

function stopRecording(): void {
	recording?.btn.classList.remove("recording");
	recording = null;
}

// Relabels a button from its actual saved hotkey and clears its status — used both to
// cancel the active recording (Escape) and to un-stick one preempted by another.
async function restoreHotkeyButton(id: HotkeyId, btn: HTMLButtonElement): Promise<void> {
	btn.textContent = hotkeyLabel(await api!.hotkey.get(id));
	setHotkeyStatus(id, "");
}

async function clearHotkey(id: HotkeyId): Promise<void> {
	const ok = await api!.hotkey.set(id, "");
	hotkeyButton(id).textContent = ok ? "none" : hotkeyLabel(await api!.hotkey.get(id));
	setHotkeyStatus(id, ok ? "Unbound." : "Failed to unbind.", ok ? "ok" : "error");
}

async function onHotkeyKeyDown(e: KeyboardEvent): Promise<void> {
	if (!recording) return;
	e.preventDefault();
	const { id, btn } = recording;

	if (e.code === "Escape") {
		stopRecording();
		await restoreHotkeyButton(id, btn);
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
	btn.textContent = ok ? accelerator : hotkeyLabel(await api!.hotkey.get(id));
	setHotkeyStatus(id, ok ? "Saved." : `${accelerator} is unavailable — try another.`, ok ? "ok" : "error");
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
