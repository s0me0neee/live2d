import { pathRequiresReload, type Config } from "../config";

// A settings-page control bound to one Config path. "ui" fields route through
// electronAPI.ui.set (showFps/showExpressions — already a live tray-driven toggle with
// its own persistence/broadcast) instead of the generic config:update patch.
interface FieldBase {
	path: string[];
	label: string;
	hint?: string;
	channel?: "ui";
}
export interface NumberField extends FieldBase {
	kind: "number";
	min: number;
	max: number;
	step: number;
}
export interface BoolField extends FieldBase {
	kind: "bool";
}
export type Field = NumberField | BoolField;

export interface Section {
	id: string;
	title: string;
	fields: Field[];
}

// Linux/Hyprland-only, rendered in its own small section — hyprlandAutoBind is
// main-process startup behavior (it drives hyprctl bind keywords), not read by the
// renderer, so unlike everything in SECTIONS it only takes effect on next launch.
export const LINUX_FIELDS: Field[] = [
	{
		kind: "bool",
		path: ["hyprlandAutoBind"],
		label: "Auto-bind on Hyprland",
		hint: "binds real keys via hyprctl · applies next launch",
	},
];

export const SECTIONS: Section[] = [
	{
		id: "feel",
		title: "Feel",
		fields: [
			{ kind: "bool", path: ["mirror"], label: "Mirror" },
			{ kind: "number", path: ["headGain"], label: "Head gain", min: 0, max: 3, step: 0.05 },
			{ kind: "number", path: ["headClampDeg"], label: "Head clamp", hint: "°", min: 0, max: 180, step: 1 },
			{ kind: "number", path: ["bodyFollow"], label: "Body follow", min: 0, max: 1, step: 0.01 },
			{ kind: "number", path: ["breath"], label: "Breath", min: 0, max: 2, step: 0.05 },
		],
	},
	{
		id: "smoothing",
		title: "Smoothing (face tracking)",
		fields: [
			{ kind: "bool", path: ["smoothing", "enabled"], label: "Enabled" },
			{ kind: "number", path: ["smoothing", "minCutoff"], label: "Min cutoff", hint: "Hz", min: 0.1, max: 10, step: 0.1 },
			{ kind: "number", path: ["smoothing", "beta"], label: "Beta", min: 0, max: 1, step: 0.01 },
			{ kind: "number", path: ["smoothing", "dCutoff"], label: "d cutoff", hint: "Hz", min: 0.1, max: 10, step: 0.1 },
		],
	},
	{
		id: "eyes-jaw",
		title: "Eyes & jaw",
		fields: [
			{ kind: "number", path: ["eyes", "deadzone"], label: "Eye deadzone", min: 0, max: 1, step: 0.01 },
			{ kind: "number", path: ["eyes", "curve"], label: "Eye curve", min: 0.1, max: 4, step: 0.05 },
			{ kind: "number", path: ["eyes", "gain"], label: "Eye gain", min: 0, max: 3, step: 0.05 },
			{ kind: "number", path: ["eyes", "gazeGain"], label: "Gaze gain", min: 0, max: 3, step: 0.05 },
			{ kind: "number", path: ["jaw", "deadzone"], label: "Jaw deadzone", min: 0, max: 1, step: 0.01 },
			{ kind: "number", path: ["jaw", "openMax"], label: "Jaw open max", min: 0.05, max: 1, step: 0.01 },
			{ kind: "number", path: ["jaw", "curve"], label: "Jaw curve", min: 0.1, max: 4, step: 0.05 },
			{ kind: "number", path: ["jaw", "gain"], label: "Jaw gain", min: 0, max: 3, step: 0.05 },
		],
	},
	{
		id: "physics",
		title: "Physics",
		fields: [
			{ kind: "bool", path: ["physics", "windEnabled"], label: "Wind enabled" },
			{ kind: "number", path: ["physics", "wind", "x"], label: "Wind X", min: -0.3, max: 0.3, step: 0.01 },
			{ kind: "number", path: ["physics", "wind", "y"], label: "Wind Y", min: -0.3, max: 0.3, step: 0.01 },
			{ kind: "number", path: ["physics", "gust"], label: "Gust", min: 0, max: 0.3, step: 0.01 },
			{ kind: "number", path: ["physics", "gustHz"], label: "Gust rate", hint: "Hz", min: 0, max: 3, step: 0.05 },
			{ kind: "number", path: ["physics", "springiness"], label: "Springiness", min: 0.5, max: 1.5, step: 0.005 },
		],
	},
	{
		id: "cursor",
		title: "Cursor look",
		fields: [
			{ kind: "bool", path: ["cursorLook", "enabled"], label: "Enabled" },
			{ kind: "number", path: ["cursorLook", "range"], label: "Range", hint: "model heights", min: 0.2, max: 5, step: 0.1 },
			{ kind: "number", path: ["cursorLook", "headDeg"], label: "Head turn", hint: "°", min: 0, max: 60, step: 1 },
			{ kind: "number", path: ["cursorLook", "eyeGain"], label: "Eye gain", min: 0, max: 5, step: 0.1 },
			{ kind: "number", path: ["cursorLook", "lagMs"], label: "Lag", hint: "ms", min: 0, max: 500, step: 10 },
		],
	},
	{
		id: "display",
		title: "Display",
		fields: [
			{ kind: "bool", path: ["showFps"], label: "Show FPS counter", channel: "ui" },
			{ kind: "bool", path: ["showExpressions"], label: "Show expression list", channel: "ui" },
			{ kind: "number", path: ["renderFps"], label: "Render FPS", min: 15, max: 240, step: 1 },
			{ kind: "number", path: ["detectFps"], label: "Detect FPS", min: 5, max: 90, step: 1 },
			{ kind: "number", path: ["camera", "width"], label: "Camera width", min: 160, max: 1920, step: 10 },
			{ kind: "number", path: ["camera", "height"], label: "Camera height", min: 120, max: 1080, step: 10 },
		],
	},
];

export function getPath(obj: unknown, path: string[]): unknown {
	return path.reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function buildPatch(path: string[], value: unknown): Record<string, unknown> {
	return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;
}

// Rebuilding a section while a *different* section has a debounced edit in flight would
// otherwise render that other field from a config snapshot that predates its own pending
// commit, snapping it back until the debounce fires — so every debounced commit counts
// itself here, and every rebuild (renderSection, and main.ts's renderGain/
// renderExpressions) checks isEditPending() in addition to its own local focus check.
let pendingEdits = 0;
export const isEditPending = (): boolean => pendingEdits > 0;

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args: A) => {
		if (!timer) pendingEdits++;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			pendingEdits--;
			fn(...args);
		}, ms);
	};
}

const formatNumber = (v: number, step: number): string => {
	const decimals = Math.max(0, -Math.floor(Math.log10(step)));
	return v.toFixed(decimals);
};

export interface FieldCommitters {
	updateConfig(patch: Record<string, unknown>): void;
	setUiToggle(key: "showFps" | "showExpressions", value: boolean): void;
}

export interface NumberRowOptions {
	label: string;
	hint?: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onCommit(value: number): void;
}

function renderLabel(row: HTMLElement, label: string, hint?: string): void {
	const labelEl = document.createElement("div");
	labelEl.className = "field-label";
	const name = document.createElement("span");
	name.className = "name";
	name.textContent = label;
	labelEl.appendChild(name);
	if (hint) {
		const hintEl = document.createElement("span");
		hintEl.className = "hint";
		hintEl.textContent = hint;
		labelEl.appendChild(hintEl);
	}
	row.appendChild(labelEl);
}

// A slider + live readout, debounced-committed on `input`. Used both for the fixed
// Config-path fields below and main.ts's per-model gain sliders (dynamic names, not a
// Config path), so row markup/debounce timing can't drift between the two.
export function renderNumberRow(container: HTMLElement, opts: NumberRowOptions): void {
	const row = document.createElement("div");
	row.className = "field-row";
	renderLabel(row, opts.label, opts.hint);

	const control = document.createElement("div");
	control.className = "field-control";
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(opts.min);
	slider.max = String(opts.max);
	slider.step = String(opts.step);
	slider.value = String(opts.value);
	const readout = document.createElement("span");
	readout.className = "readout";
	readout.textContent = formatNumber(opts.value, opts.step);
	const commit = debounce(opts.onCommit, 200);
	slider.addEventListener("input", () => {
		const v = Number(slider.value);
		readout.textContent = formatNumber(v, opts.step);
		commit(v);
	});
	control.append(slider, readout);

	row.appendChild(control);
	container.appendChild(row);
}

// Renders one field row and wires its change handler. Checkboxes commit immediately
// since `change` only fires once per toggle; numbers delegate to renderNumberRow.
export function renderField(container: HTMLElement, field: Field, config: Config, commit: FieldCommitters): void {
	const send = (value: unknown) => {
		if (field.channel === "ui") commit.setUiToggle(field.path[0] as "showFps" | "showExpressions", value as boolean);
		else commit.updateConfig(buildPatch(field.path, value));
	};
	const hint = [field.hint, pathRequiresReload(field.path) ? "reloads" : undefined]
		.filter((h): h is string => Boolean(h))
		.join(" · ");

	if (field.kind === "number") {
		renderNumberRow(container, {
			label: field.label,
			hint: hint || undefined,
			min: field.min,
			max: field.max,
			step: field.step,
			value: Number(getPath(config, field.path) ?? 0),
			onCommit: send,
		});
		return;
	}

	const row = document.createElement("div");
	row.className = "field-row";
	renderLabel(row, field.label, hint || undefined);

	const control = document.createElement("div");
	control.className = "field-control";
	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.checked = Boolean(getPath(config, field.path));
	// "ui"-channel fields (showFps/showExpressions) can also change from outside this
	// window (the tray) — see src/settings/main.ts's initUiToggleSync, which needs to
	// find this exact checkbox to update it without a full section rebuild.
	if (field.channel === "ui") checkbox.dataset.path = field.path.join(".");
	checkbox.addEventListener("change", () => send(checkbox.checked));
	control.appendChild(checkbox);

	row.appendChild(control);
	container.appendChild(row);
}

// Rebuilds a section's rows from the latest config — skipped while the user has focus
// inside the container (an in-flight edit here) or has a debounced edit pending in any
// other section (an in-flight edit there that this snapshot predates).
export function renderSection(container: HTMLElement, fields: Field[], config: Config, commit: FieldCommitters): void {
	if (isEditPending() || container.contains(document.activeElement)) return;
	container.innerHTML = "";
	for (const field of fields) renderField(container, field, config, commit);
}
