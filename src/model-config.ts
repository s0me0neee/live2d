/**
 * Per-model settings. Everything here is specific to the loaded model — its
 * files, on-screen size, and how its secondary-motion parameters are named.
 * Swap these (and regenerate src/expressions/generated.ts) to use another model.
 *
 * The model-INDEPENDENT tuning (head/eye/mouth feel, breath, wind, performance)
 * lives in config.ts and works on any Cubism 4 model unchanged.
 */
export const modelConfig = {
	// --- assets ---
	dir: "/model/ariu/",
	file: "ariu.model3.json",
	scale: 0.2, // on-screen size; depends on the model's native canvas

	// --- secondary motion (physics OUTPUT params, matched by id prefix) ---
	// Hair/cloth params are model-specific in name. Each `gain` scales how far
	// those params swing from rest (1 = model default, >1 = swingier).
	// Set `prefix` to "" to disable a group, or to this model's actual naming.
	hair: { prefix: "ParamHair", gain: 1.7 },
	clothes: { prefix: "Param_Angle_Rotation", gain: 2 },
} as const;
