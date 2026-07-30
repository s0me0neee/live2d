import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config, ModelConfig } from "./config";

// The Live2D parameters we drive (with their value ranges).
export interface Rig {
	angleX: number; // head yaw
	angleY: number; // head pitch
	angleZ: number; // head roll
	eyeLOpen: number; // 0..1
	eyeROpen: number; // 0..1
	eyeBallX: number; // -1..1
	eyeBallY: number; // -1..1
	mouthOpen: number; // 0..1
	mouthForm: number; // 0..1 (smile)
	browLY: number; // -1..1
	browRY: number; // -1..1
}

// What a look-at source (the cursor) can aim: head and gaze only. Everything else in
// Rig needs a face to measure.
export interface LookTarget {
	angleX: number;
	angleY: number;
	angleZ: number;
	eyeBallX: number;
	eyeBallY: number;
}

// The two pose sources write their target here; the driver picks one, smooths it and
// writes the parameters. Face tracking is authoritative while its results keep arriving.
export interface RigDriver {
	pose: Rig;
	look: LookTarget;
	markFaceFresh(): void;
}

export const neutral = (): Rig => ({
	angleX: 0, angleY: 0, angleZ: 0,
	eyeLOpen: 1, eyeROpen: 1,
	eyeBallX: 0, eyeBallY: 0,
	mouthOpen: 0, mouthForm: 0,
	browLY: 0, browRY: 0,
});

const neutralLook = (): LookTarget => ({
	angleX: 0, angleY: 0, angleZ: 0,
	eyeBallX: 0, eyeBallY: 0,
});

// Precomputed so the per-frame smoothing loop allocates nothing.
const RIG_KEYS = Object.keys(neutral()) as (keyof Rig)[];

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The face worker posts nothing at all when MediaPipe finds no face (see face-worker.ts),
// so "no result recently" covers a missing/denied camera, a dead worker AND a face that
// left the frame, with no extra signalling. ~15 missed frames at detectFps 30.
const FACE_STALE_MS = 500;

// Smooths the selected target and writes parameters. Face params go on afterMotionUpdate
// (so the hair/cloth physics reacts to them); body + gain params go on beforeModelUpdate
// (after physics, which would otherwise clobber them).
export function createRigDriver(
	model: Live2DModel,
	config: Config,
	modelConfig: ModelConfig,
): RigDriver {
	const internal = model.internalModel as any;
	const cm = internal.coreModel;

	const pose = neutral(); // latest detection
	const look = neutralLook(); // latest cursor aim
	const target = neutral(); // whichever source is currently in charge
	const rig = neutral(); // smoothed values actually applied

	let lastFaceAt = -Infinity;
	let wasFaceLive = false;

	// The runtime's idle auto-blink. It runs *after* afterMotionUpdate (see
	// InternalModel.update), so it would overwrite our eyelid writes — hence handing it
	// back and forth rather than clearing it once: while no face is tracked nothing else
	// drives the eyelids, and without this the model would simply stop blinking.
	// Undefined on models whose settings declare no eye-blink params.
	const idleBlink = internal.eyeBlink;

	const set = (id: string, v: number) => cm.setParameterValueById(id, v);
	const head = modelConfig.headAngle;

	internal.on("afterMotionUpdate", () => {
		const faceLive = performance.now() - lastFaceAt < FACE_STALE_MS;
		if (faceLive !== wasFaceLive) {
			internal.eyeBlink = faceLive ? undefined : idleBlink;
			wasFaceLive = faceLive;
		}

		selectTarget(target, pose, look, faceLive, config);
		for (const k of RIG_KEYS) rig[k] += (target[k] - rig[k]) * config.smoothing;

		set(head.x, rig.angleX);
		set(head.y, rig.angleY);
		set(head.z, rig.angleZ);
		set("ParamEyeBallX", rig.eyeBallX);
		set("ParamEyeBallY", rig.eyeBallY);

		// Only a real face measures these; while the cursor is driving, leave them to the
		// auto-blink and to whatever expressions/motions are playing.
		if (faceLive) {
			set("ParamEyeLOpen", rig.eyeLOpen);
			set("ParamEyeROpen", rig.eyeROpen);
			set("ParamMouthOpenY", rig.mouthOpen);
			set("ParamMouthForm", rig.mouthForm);
			set("ParamBrowLY", rig.browLY);
			set("ParamBrowRY", rig.browRY);
		}
	});

	// Resolve each [gain] setting's physics-output params to their rest values once.
	const restById = new Map(
		(cm._model.parameters.ids as string[]).map(
			(id, index) => [id, cm.getParameterDefaultValue(index)] as const,
		),
	);
	const gainGroups: { gain: number; params: { id: string; rest: number }[] }[] = [];
	for (const { value, params } of Object.values(modelConfig.gain)) {
		if (value === 1) continue;
		const matched = params
			.filter((id) => restById.has(id))
			.map((id) => ({ id, rest: restById.get(id) as number }));
		if (matched.length) gainGroups.push({ gain: value, params: matched });
	}

	const swing = (params: { id: string; rest: number }[], gain: number) => {
		for (const p of params) {
			const cur = cm.getParameterValueById(p.id);
			set(p.id, p.rest + (cur - p.rest) * gain);
		}
	};

	// Linear body-follow as a fallback, applied after physics so it wins — but only
	// for body params the model's physics does NOT already derive from the head. When
	// physics drives the body, overriding it here fights the sim and can invert the
	// lean (the body swings opposite the head), so we leave those to physics.
	const f = config.bodyFollow;
	const physicsDriven = new Set(modelConfig.physicsBodyParams);
	const followBody = (id: string, v: number) => {
		if (!physicsDriven.has(id)) set(id, v);
	};
	internal.on("beforeModelUpdate", () => {
		followBody("ParamBodyAngleX", rig.angleX * f);
		followBody("ParamBodyAngleY", rig.angleY * f);
		followBody("ParamBodyAngleZ", rig.angleZ * f);
		followBody("ParamBodyAngleZ2", rig.angleZ * f);

		for (const g of gainGroups) swing(g.params, g.gain);
	});

	return {
		pose,
		look,
		markFaceFresh: () => {
			lastFaceAt = performance.now();
		},
	};
}

// Both sources emit unclamped values; the clamps live here so headClampDeg is applied
// exactly once no matter which one is driving.
function selectTarget(
	out: Rig,
	pose: Rig,
	look: LookTarget,
	faceLive: boolean,
	config: Config,
): void {
	if (faceLive) {
		for (const k of RIG_KEYS) out[k] = pose[k];
	} else {
		out.angleX = look.angleX;
		out.angleY = look.angleY;
		out.angleZ = look.angleZ;
		out.eyeBallX = look.eyeBallX;
		out.eyeBallY = look.eyeBallY;
		// Rest the face-only fields rather than holding the last detection's grin.
		out.eyeLOpen = 1;
		out.eyeROpen = 1;
		out.mouthOpen = 0;
		out.mouthForm = 0;
		out.browLY = 0;
		out.browRY = 0;
	}

	const lim = config.headClampDeg;
	out.angleX = clamp(out.angleX, -lim, lim);
	out.angleY = clamp(out.angleY, -lim, lim);
	out.angleZ = clamp(out.angleZ, -lim, lim);
	out.eyeBallX = clamp(out.eyeBallX, -1, 1);
	out.eyeBallY = clamp(out.eyeBallY, -1, 1);
}
