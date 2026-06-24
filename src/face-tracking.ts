import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import { config } from "./config";
import { modelConfig } from "./model-config";

// The Live2D parameters we drive from the webcam.
interface Rig {
	angleX: number; // head yaw   (-30..30)
	angleY: number; // head pitch (-30..30)
	angleZ: number; // head roll  (-30..30)
	eyeLOpen: number; // 0..1
	eyeROpen: number; // 0..1
	eyeBallX: number; // -1..1
	eyeBallY: number; // -1..1
	mouthOpen: number; // 0..1
	mouthForm: number; // 0..1 (smile)
	browLY: number; // -1..1
	browRY: number; // -1..1
}

const neutral = (): Rig => ({
	angleX: 0, angleY: 0, angleZ: 0,
	eyeLOpen: 1, eyeROpen: 1,
	eyeBallX: 0, eyeBallY: 0,
	mouthOpen: 0, mouthForm: 0,
	browLY: 0, browRY: 0,
});

// Precomputed once so the per-frame smoothing loop allocates nothing.
const RIG_KEYS = Object.keys(neutral()) as (keyof Rig)[];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Starts webcam face tracking and drives the given Live2D model.
 * Resolves once the camera + landmarker are ready (throws if the camera is
 * denied/unavailable so the caller can keep the app running without tracking).
 */
export async function startFaceTracking(model: Live2DModel): Promise<void> {
	const video = await openCamera();
	const landmarker = await createLandmarker();

	const target = neutral(); // latest detection
	const rig = neutral(); // smoothed values actually applied

	startDetectionLoop(video, landmarker, target);
	driveModel(model, rig, target);
}

/** Opens the user-facing camera into a hidden, playing <video>. */
async function openCamera(): Promise<HTMLVideoElement> {
	const video = document.createElement("video");
	video.autoplay = true;
	video.playsInline = true;
	video.muted = true;
	video.style.display = "none";
	document.body.appendChild(video);

	video.srcObject = await navigator.mediaDevices.getUserMedia({
		video: { ...config.camera, facingMode: "user" },
		audio: false,
	});
	await video.play();
	return video;
}

/** Creates the MediaPipe Face Landmarker (assets vendored under /public). */
async function createLandmarker(): Promise<FaceLandmarker> {
	const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
	return FaceLandmarker.createFromOptions(fileset, {
		baseOptions: {
			modelAssetPath: "/mediapipe/face_landmarker.task",
			delegate: "GPU",
		},
		runningMode: "VIDEO",
		numFaces: 1,
		outputFaceBlendshapes: true,
		outputFacialTransformationMatrixes: true,
	});
}

/**
 * Runs inference at most `config.detectFps` times a second (it's the dominant
 * cost), independent of the render loop, writing into `target`.
 */
function startDetectionLoop(
	video: HTMLVideoElement,
	landmarker: FaceLandmarker,
	target: Rig,
): void {
	const minInterval = 1000 / config.detectFps;
	let lastDetect = 0;
	let lastVideoTime = -1;

	const detect = (now: number) => {
		requestAnimationFrame(detect);
		// throttle to the target rate, and skip if the frame hasn't advanced
		if (now - lastDetect < minInterval || video.currentTime === lastVideoTime) return;
		lastDetect = now;
		lastVideoTime = video.currentTime;

		const res = landmarker.detectForVideo(video, now);
		if (res.faceBlendshapes?.length) mapResult(res, target);
	};
	requestAnimationFrame(detect);
}

/**
 * Hooks the model's update so it smooths toward `target` and writes parameters.
 * - face params on "afterMotionUpdate" (so the hair/cloth physics reacts to them)
 * - body params on "beforeModelUpdate" (after physics, which would clobber them)
 */
function driveModel(model: Live2DModel, rig: Rig, target: Rig): void {
	const internal = model.internalModel as any;
	const cm = internal.coreModel;
	internal.eyeBlink = undefined; // we drive the eyes ourselves
	(model as any).automator.autoFocus = false; // stop following the mouse

	const set = (id: string, v: number) => cm.setParameterValueById(id, v);

	internal.on("afterMotionUpdate", () => {
		for (const k of RIG_KEYS) rig[k] += (target[k] - rig[k]) * config.smoothing;

		set("ParamAngleX", rig.angleX);
		set("ParamAngleY", rig.angleY);
		set("ParamAngleZ", rig.angleZ);
		set("ParamEyeLOpen", rig.eyeLOpen);
		set("ParamEyeROpen", rig.eyeROpen);
		set("ParamEyeBallX", rig.eyeBallX);
		set("ParamEyeBallY", rig.eyeBallY);
		set("ParamMouthOpenY", rig.mouthOpen);
		set("ParamMouthForm", rig.mouthForm);
		set("ParamBrowLY", rig.browLY);
		set("ParamBrowRY", rig.browRY);
	});

	// Hair and cloth params are physics OUTPUTS; collect each group (with rest
	// values) so we can scale their swing around rest after physics has run.
	const ids = cm._model.parameters.ids as string[];
	const group = (pred: (id: string) => boolean) =>
		ids.map((id, index) => ({ id, def: cm.getParameterDefaultValue(index) }))
			.filter((p) => pred(p.id));
	const hair = group((id) => id.startsWith(modelConfig.hair.prefix));
	const clothes = group((id) => id.startsWith(modelConfig.clothes.prefix));

	// Scale a group's deviation from rest by `gain` (no-op at 1).
	const swing = (params: { id: string; def: number }[], gain: number) => {
		if (gain === 1) return;
		for (const p of params) {
			const cur = cm.getParameterValueById(p.id);
			set(p.id, p.def + (cur - p.def) * gain);
		}
	};

	// ParamBodyAngle* are physics OUTPUTS (driven by head angle in
	// ariu.physics3.json); this hook runs AFTER physics, so our values win.
	// ParamBodyAngleZ2 is the rig's counter-rotation term — match its sign too.
	const f = config.bodyFollow;
	internal.on("beforeModelUpdate", () => {
		set("ParamBodyAngleX", rig.angleX * f);
		set("ParamBodyAngleY", rig.angleY * f);
		set("ParamBodyAngleZ", rig.angleZ * f);
		set("ParamBodyAngleZ2", rig.angleZ * f);

		swing(hair, modelConfig.hair.gain);
		swing(clothes, modelConfig.clothes.gain);
	});
}

/** Translate one MediaPipe result into Live2D-shaped rig values. */
function mapResult(res: any, out: Rig): void {
	const bs: Record<string, number> = {};
	for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
	const v = (name: string) => bs[name] ?? 0;

	const { mirror, headGain, headClampDeg: lim, blinkGain, jaw: jc } = config;
	const ms = mirror ? -1 : 1;

	// --- head pose from the 4x4 facial transformation matrix (column-major) ---
	const m: number[] | undefined = res.facialTransformationMatrixes?.[0]?.data;
	if (m) {
		const r = (row: number, col: number) => m[col * 4 + row];
		const yaw = Math.atan2(r(0, 2), r(2, 2));
		const pitch = Math.atan2(-r(1, 2), Math.hypot(r(0, 2), r(2, 2)));
		const roll = Math.atan2(r(1, 0), r(1, 1));
		const deg = 180 / Math.PI;
		out.angleX = clamp(yaw * deg * ms * headGain, -lim, lim);
		out.angleY = clamp(-pitch * deg * headGain, -lim, lim); // head up -> model up
		out.angleZ = clamp(-roll * deg * ms * headGain, -lim, lim); // tilt -> model tilts same way
	}

	// --- eyes (mirror-swap so it reads like a mirror) ---
	let blinkL = v("eyeBlinkLeft");
	let blinkR = v("eyeBlinkRight");
	if (mirror) [blinkL, blinkR] = [blinkR, blinkL];
	out.eyeLOpen = clamp(1 - blinkL * blinkGain, 0, 1);
	out.eyeROpen = clamp(1 - blinkR * blinkGain, 0, 1);

	// --- gaze ---
	const gx =
		(v("eyeLookInLeft") + v("eyeLookOutRight")) / 2 -
		(v("eyeLookOutLeft") + v("eyeLookInRight")) / 2;
	const gy =
		(v("eyeLookUpLeft") + v("eyeLookUpRight")) / 2 -
		(v("eyeLookDownLeft") + v("eyeLookDownRight")) / 2;
	out.eyeBallX = clamp(gx * ms, -1, 1);
	out.eyeBallY = clamp(gy, -1, 1);

	// --- mouth: deadzone kills closed-mouth jitter; concave curve lifts speech ---
	const jaw = clamp((v("jawOpen") - jc.deadzone) / (1 - jc.deadzone), 0, 1);
	out.mouthOpen = clamp(Math.pow(jaw, jc.curve) * jc.gain, 0, 1);
	out.mouthForm = clamp((v("mouthSmileLeft") + v("mouthSmileRight")) / 2, 0, 1);

	// --- brows ---
	out.browLY = clamp(v("browInnerUp") - v("browDownLeft"), -1, 1);
	out.browRY = clamp(v("browInnerUp") - v("browDownRight"), -1, 1);
}
