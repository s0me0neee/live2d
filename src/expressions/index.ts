import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { ModelConfig } from "../config";
import { modelAssetUrl } from "../model-url";

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

// Independent outfit/face toggles: several can be on at once. Applied imperatively
// on toggle (Cubism keeps the last written value) and reset to default on off.
// On/off state is restored from, and persisted back into, the model's TOML.
export async function setupExpressions(
	model: Live2DModel,
	modelConfig: ModelConfig,
	visible: boolean,
): Promise<void> {
	const base = modelConfig.resolvedLocation || modelConfig.location;
	const defs: LoadedExpression[] = await Promise.all(
		Object.entries(modelConfig.expressions).map(async ([name, e]) => {
			const data = await fetch(modelAssetUrl(base, e.file)).then((r) => r.json());
			return { name, key: e.key, params: (data.Parameters ?? []) as ExpParam[] };
		}),
	);

	const cm = (model.internalModel as any).coreModel;

	// Each param's default ("off") value, captured before any expression changes it.
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

	const panel = buildPanel(defs, setActive);
	const setVisible = (v: boolean) => {
		panel.style.display = v ? "" : "none";
	};
	setVisible(visible);
	window.electronAPI?.ui?.onShowExpressions(setVisible);

	for (const d of defs) {
		if (modelConfig.expressions[d.name]?.active) setActive(d, true, false);
	}

	window.addEventListener("keydown", (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const d = defs.find((x) => x.key && x.key === e.key);
		if (d) setActive(d, !active.has(d.name));
	});
}

function buildPanel(
	defs: LoadedExpression[],
	setActive: (d: LoadedExpression, on: boolean) => void,
): HTMLDivElement {
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
	return panel;
}
