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

// Independent outfit/face toggles (several can be on at once), applied imperatively
// and reset to default on off. On/off state round-trips through the model's TOML.
export async function setupExpressions(
	model: Live2DModel,
	modelConfig: ModelConfig,
	visible: boolean,
): Promise<void> {
	const base = modelConfig.resolvedLocation || modelConfig.location;
	// Load each file independently so one missing/corrupt .exp3.json drops only that
	// expression instead of rejecting the whole set and disabling the panel.
	const loaded = await Promise.all(
		Object.entries(modelConfig.expressions).map(async ([name, e]) => {
			try {
				const data = await fetch(modelAssetUrl(base, e.file)).then((r) => r.json());
				return { name, key: e.key, params: (data.Parameters ?? []) as ExpParam[] };
			} catch (err) {
				console.warn(`[expr] skipping "${name}" (${e.file}):`, err);
				return null;
			}
		}),
	);
	const defs: LoadedExpression[] = loaded.filter((d): d is LoadedExpression => d !== null);

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
