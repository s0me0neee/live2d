import { Ticker } from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config, ModelConfig } from "./config";
import { createOneEuroFilter } from "./one-euro-filter";

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

// The two pose sources write their target here. Each is smoothed independently (face
// tracking through its own adaptive filter, cursor-look through its own separate
// lagMs), and the driver picks whichever is live to write parameters from. Face
// tracking is authoritative while its results keep arriving.
export interface RigDriver {
	pose: Rig;
	look: LookTarget;
	markFaceFresh(): void;
	// Recomputes the physics-output gain groups from the latest modelConfig.gain values
	// (a settings-window slider edit) — everything else Config-level rig reads fresh off
	// the same object each frame already, but gain groups are a derived cache, not a
	// straight read, so they need an explicit refresh.
	refreshGain(): void;
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

// Precomputed so the per-frame loop and the filter bank below allocate nothing.
const RIG_KEYS = Object.keys(neutral()) as (keyof Rig)[];

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The face worker posts nothing at all when MediaPipe finds no face (see face-worker.ts),
// so "no result recently" covers a missing/denied camera, a dead worker AND a face that
// left the frame, with no extra signalling. ~30 missed frames at the default detectFps 60.
const FACE_STALE_MS = 500;

// Smooths each source independently and writes parameters. Face params go on
// afterMotionUpdate (so the hair/cloth physics reacts to them); body + gain params go
// on beforeModelUpdate (after physics, which would otherwise clobber them).
export function createRigDriver(
	model: Live2DModel,
	config: Config,
	modelConfig: ModelConfig,
): RigDriver {
	const internal = model.internalModel as any;
	const cm = internal.coreModel;

	const pose = neutral(); // latest detection, unclamped, written by face-tracking.ts
	const clampedPose = neutral(); // pose after headClampDeg/gaze clamp, pre-filter scratch
	const smoothedPose = neutral(); // face-tracking pipeline's output
	const look = neutralLook(); // latest cursor aim — already smoothed by cursor-look.ts
	const rig = neutral(); // final values actually written to Live2D params

	// One filter per Rig channel — angle/eye/mouth/brow all move too differently to
	// share one filter's velocity estimate. Only feeds from `pose`; cursor-look's `look`
	// has its own separate lagMs smoothing and never touches these.
	const poseFilters = RIG_KEYS.map(() => createOneEuroFilter());

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
			// A stale gap (camera covered, face out of frame) can be minutes long. Without
			// this, the filters' next real sample would compute velocity against that whole
			// gap and read as near-zero speed, sweeping in slowly instead of snapping back
			// onto the real position. Runs on both directions of the transition — a no-op
			// when losing the face, since smoothedPose isn't selected into rig while !faceLive.
			poseFilters.forEach((f) => f.reset());
		}

		// Face-tracking pipeline: clamp once, then filter (or bypass when disabled) — runs
		// every tick regardless of faceLive, so it's already caught up by the time it's
		// selected below.
		const lim = config.headClampDeg;
		clampPose(clampedPose, pose, lim);
		if (config.smoothing.enabled) {
			RIG_KEYS.forEach((key, i) => {
				smoothedPose[key] = poseFilters[i].step(clampedPose[key], Ticker.shared.deltaMS, config.smoothing);
			});
		} else {
			for (const key of RIG_KEYS) smoothedPose[key] = clampedPose[key];
		}

		// Selection: cursor-look's own smoothing already ran (cursor-look.ts), so `look`
		// only needs the same clamp face-tracking gets, not another filtering pass.
		if (faceLive) {
			for (const key of RIG_KEYS) rig[key] = smoothedPose[key];
		} else {
			rig.angleX = clamp(look.angleX, -lim, lim);
			rig.angleY = clamp(look.angleY, -lim, lim);
			rig.angleZ = clamp(look.angleZ, -lim, lim);
			rig.eyeBallX = clamp(look.eyeBallX, -1, 1);
			rig.eyeBallY = clamp(look.eyeBallY, -1, 1);
			// Rest the face-only fields rather than holding the last detection's grin.
			rig.eyeLOpen = 1;
			rig.eyeROpen = 1;
			rig.mouthOpen = 0;
			rig.mouthForm = 0;
			rig.browLY = 0;
			rig.browRY = 0;
		}

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
	// Guarded like physics.ts's private-field digs: a runtime shape change here should
	// disable gain scaling, not crash boot.
	const restById = new Map(
		((cm._model?.parameters?.ids as string[] | undefined) ?? []).map(
			(id, index) => [id, cm.getParameterDefaultValue(index)] as const,
		),
	);
	type GainGroup = { gain: number; params: { id: string; rest: number }[] };
	function computeGainGroups(gain: ModelConfig["gain"]): GainGroup[] {
		const groups: GainGroup[] = [];
		for (const { value, params } of Object.values(gain)) {
			if (value === 1) continue;
			const matched = params
				.filter((id) => restById.has(id))
				.map((id) => ({ id, rest: restById.get(id) as number }));
			if (matched.length) groups.push({ gain: value, params: matched });
		}
		return groups;
	}
	let gainGroups = computeGainGroups(modelConfig.gain);

	const swing = (params: { id: string; rest: number }[], gain: number) => {
		for (const p of params) {
			const cur = cm.getParameterValueById(p.id);
			set(p.id, p.rest + (cur - p.rest) * gain);
		}
	};

	// Linear body-follow as a fallback, applied after physics so it wins — but only
	// for body params the model's physics does NOT already derive from the head. When
	// physics drives the body, overriding it here fights the sim and can invert the
	// lean (the body swings opposite the head), so we leave those to physics. Reads
	// config.bodyFollow fresh each frame (not captured once) so a settings-window edit
	// applies live.
	const physicsDriven = new Set(modelConfig.physicsBodyParams);
	const followBody = (id: string, v: number) => {
		if (!physicsDriven.has(id)) set(id, v);
	};
	internal.on("beforeModelUpdate", () => {
		const f = config.bodyFollow;
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
		refreshGain: () => {
			gainGroups = computeGainGroups(modelConfig.gain);
		},
	};
}

// pose emits unclamped values; this is the one place headClampDeg/gaze range applies,
// upstream of both the filter and the disabled-filter bypass so it's never skipped.
function clampPose(out: Rig, src: Rig, lim: number): void {
	out.angleX = clamp(src.angleX, -lim, lim);
	out.angleY = clamp(src.angleY, -lim, lim);
	out.angleZ = clamp(src.angleZ, -lim, lim);
	out.eyeBallX = clamp(src.eyeBallX, -1, 1);
	out.eyeBallY = clamp(src.eyeBallY, -1, 1);
	out.eyeLOpen = src.eyeLOpen;
	out.eyeROpen = src.eyeROpen;
	out.mouthOpen = src.mouthOpen;
	out.mouthForm = src.mouthForm;
	out.browLY = src.browLY;
	out.browRY = src.browRY;
}
