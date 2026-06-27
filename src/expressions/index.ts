import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { ModelConfig } from "../config";

interface ExpParam {
	Id: string;
	Value: number;
}

interface LoadedExpression {
	name: string;
	key: string;
	params: ExpParam[];
	checkbox?: HTMLInputElement;
}

/**
 * Loads the model's discovered expressions, builds a toggle panel + keyboard
 * shortcuts, and applies expression parameters to the model.
 *
 * These are independent outfit/face toggles (a dedicated "Add" param each), so
 * several can be on at once. Cubism keeps the last value we write, so we apply
 * params imperatively on toggle (no per-frame work) and reset to default on off.
 * The on/off state is restored from, and persisted back into, the model's TOML.
 */
export async function setupExpressions(model: Live2DModel, modelConfig: ModelConfig): Promise<void> {
	const entries = Object.entries(modelConfig.expressions);
	const defs: LoadedExpression[] = await Promise.all(
		entries.map(async ([name, e]) => {
			const data = await fetch(`/${modelConfig.location}/${e.file}`).then((r) => r.json());
			return { name, key: e.key, params: (data.Parameters ?? []) as ExpParam[] };
		}),
	);

	const cm = (model.internalModel as any).coreModel;

	// Each expression param's default ("off") value, captured before any change.
	const offValue = new Map<string, number>();
	for (const d of defs) {
		for (const p of d.params) {
			if (!offValue.has(p.Id)) {
				offValue.set(p.Id, cm.getParameterDefaultValue(cm.getParameterIndex(p.Id)));
			}
		}
	}

	const active = new Set<string>();
	const setActive = (d: LoadedExpression, on: boolean, persist = true) => {
		if (on) active.add(d.name);
		else active.delete(d.name);
		if (d.checkbox) d.checkbox.checked = on;
		for (const p of d.params) {
			cm.setParameterValueById(p.Id, on ? p.Value : (offValue.get(p.Id) ?? 0));
		}
		if (persist) window.electronAPI?.setExpression(d.name, on).catch(() => {});
	};

	buildPanel(defs, setActive);

	// Restore saved on-state without re-persisting it back.
	for (const d of defs) {
		if (modelConfig.expressions[d.name]?.active) setActive(d, true, false);
	}

	window.addEventListener("keydown", (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const d = defs.find((x) => x.key && x.key === e.key);
		if (d) setActive(d, !active.has(d.name));
	});
}

/** Builds the top-right checkbox panel (styled via #expr-panel in styles.css). */
function buildPanel(
	defs: LoadedExpression[],
	setActive: (d: LoadedExpression, on: boolean) => void,
): void {
	const panel = document.createElement("div");
	panel.id = "expr-panel";

	const title = document.createElement("div");
	title.className = "expr-title";
	title.textContent = "Expressions";
	panel.appendChild(title);

	for (const d of defs) {
		const label = document.createElement("label");
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.addEventListener("change", () => setActive(d, cb.checked));
		d.checkbox = cb;

		const text = document.createElement("span");
		text.textContent = `${d.name}${d.key ? ` (${d.key})` : ""}`;

		label.append(cb, text);
		panel.appendChild(label);
	}
	document.body.appendChild(panel);
}
