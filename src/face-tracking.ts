import { FaceLandmarker, PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";

// Set true so the model mirrors you (like looking in a mirror). Flip if it
// feels backwards. Head-angle/eye signs below also depend on this.
const MIRROR = true;

// Per-frame smoothing toward the latest detected values (0..1, higher = snappier).
const SMOOTHING = 0.5;

// Camera sensitivity: model rotation per degree of head movement (higher = more).
const HEAD_GAIN = 1.5;

// Body capture (from shoulders via PoseLandmarker). Gains map normalized pose
// measurements to the model's ParamBodyAngle* range (roughly -10..10).
const BODY_ROLL_GAIN = 1.4; // shoulder tilt -> body roll (ParamBodyAngleZ)
const BODY_LEAN_GAIN = 45; // horizontal shoulder shift -> body lean (ParamBodyAngleX)
const BODY_RISE_GAIN = 40; // vertical shoulder shift -> body pitch (ParamBodyAngleY)

// Resting shoulder position, captured once, so lean/rise are measured relative
// to where you sit (no hard-coded "center" assumption).
let poseBaseline: { x: number; y: number } | null = null;

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
	bodyAngleX: number; // body lean L/R   (-10..10), from shoulders
	bodyAngleY: number; // body rise/sink   (-10..10), from shoulders
	bodyAngleZ: number; // body roll/tilt   (-10..10), from shoulders
}

const neutral = (): Rig => ({
	angleX: 0, angleY: 0, angleZ: 0,
	eyeLOpen: 1, eyeROpen: 1,
	eyeBallX: 0, eyeBallY: 0,
	mouthOpen: 0, mouthForm: 0,
	browLY: 0, browRY: 0,
	bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Starts webcam face tracking and drives the given Live2D model.
 * Resolves once the camera + landmarker are ready (throws if the camera is
 * denied/unavailable so the caller can keep the app running without tracking).
 */
export async function startFaceTracking(model: Live2DModel): Promise<void> {
	// --- webcam into a hidden <video> ---
	const video = document.createElement("video");
	video.autoplay = true;
	video.playsInline = true;
	video.muted = true;
	video.style.display = "none";
	document.body.appendChild(video);

	const stream = await navigator.mediaDevices.getUserMedia({
		video: { width: 640, height: 480, facingMode: "user" },
		audio: false,
	});
	video.srcObject = stream;
	await video.play();

	// --- MediaPipe Face Landmarker (assets vendored under /public/mediapipe) ---
	const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
	const landmarker = await FaceLandmarker.createFromOptions(fileset, {
		baseOptions: {
			modelAssetPath: "/mediapipe/face_landmarker.task",
			delegate: "GPU",
		},
		runningMode: "VIDEO",
		numFaces: 1,
		outputFaceBlendshapes: true,
		outputFacialTransformationMatrixes: true,
	});

	// --- MediaPipe Pose Landmarker: tracks shoulders/torso for real body motion ---
	const poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
		baseOptions: {
			modelAssetPath: "/mediapipe/pose_landmarker_lite.task",
			delegate: "GPU",
		},
		runningMode: "VIDEO",
		numPoses: 1,
	});

	const target = neutral(); // latest detection
	const rig = neutral(); // smoothed values actually applied

	// --- detection loop (decoupled from the render loop) ---
	let lastVideoTime = -1;
	const detect = () => {
		if (video.currentTime !== lastVideoTime) {
			lastVideoTime = video.currentTime;
			const now = performance.now();
			const res = landmarker.detectForVideo(video, now);
			if (res.faceBlendshapes?.length) {
				mapResult(res, target);
			}
			const pose = poseLandmarker.detectForVideo(video, now);
			if (pose.landmarks?.length) {
				mapPose(pose, target);
			}
		}
		requestAnimationFrame(detect);
	};
	requestAnimationFrame(detect);

	// --- push values into the model ---
	const internal = model.internalModel as any;
	internal.eyeBlink = undefined; // we drive the eyes ourselves
	(model as any).automator.autoFocus = false; // stop hair/clothes following the mouse

	// "afterMotionUpdate" fires BEFORE physics is evaluated, so the hair/cloth
	// physics reacts to our face values too (not just the visible head deform).
	internal.on("afterMotionUpdate", () => {
		// smooth toward the target each render frame
		for (const k of Object.keys(rig) as (keyof Rig)[]) {
			rig[k] += (target[k] - rig[k]) * SMOOTHING;
		}
		const cm = internal.coreModel;
		const set = (id: string, v: number) => cm.setParameterValueById(id, v);

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
		// NOTE: ParamBodyAngle* are physics OUTPUTS (driven by head angle in
		// ariu.physics3.json), so writing them here is pointless — physics, which
		// runs after this hook, overwrites them. We override them post-physics in
		// the beforeModelUpdate handler below instead.
	});

	// --- drive body angles from the POSE capture (shoulders), not the head ---
	// ParamBodyAngle* are physics OUTPUTS (driven by head angle in
	// ariu.physics3.json); this hook runs AFTER physics, so our values win.
	// ParamBodyAngleZ2 is the rig's counter-rotation term — match its sign too.
	internal.on("beforeModelUpdate", () => {
		const cm = internal.coreModel;
		cm.setParameterValueById("ParamBodyAngleX", rig.bodyAngleX);
		cm.setParameterValueById("ParamBodyAngleY", rig.bodyAngleY);
		cm.setParameterValueById("ParamBodyAngleZ", rig.bodyAngleZ);
		cm.setParameterValueById("ParamBodyAngleZ2", rig.bodyAngleZ);
	});
}

/** Translate one MediaPipe result into Live2D-shaped rig values. */
function mapResult(res: any, out: Rig): void {
	// blendshapes -> name->score map
	const bs: Record<string, number> = {};
	for (const c of res.faceBlendshapes[0].categories) {
		bs[c.categoryName] = c.score;
	}
	const v = (name: string) => bs[name] ?? 0;

	// --- head pose from the 4x4 facial transformation matrix (column-major) ---
	const m: number[] | undefined = res.facialTransformationMatrixes?.[0]?.data;
	if (m) {
		const r = (row: number, col: number) => m[col * 4 + row];
		const yaw = Math.atan2(r(0, 2), r(2, 2));
		const pitch = Math.atan2(-r(1, 2), Math.hypot(r(0, 2), r(2, 2)));
		const roll = Math.atan2(r(1, 0), r(1, 1));
		const deg = 180 / Math.PI;
		const ms = MIRROR ? -1 : 1;
		out.angleX = clamp(yaw * deg * ms * HEAD_GAIN, -70, 70);
		out.angleY = clamp(-pitch * deg * HEAD_GAIN, -70, 70); // head up -> model up
		out.angleZ = clamp(-roll * deg * ms * HEAD_GAIN, -70, 70); // tilt head -> model tilts same way
	}

	// --- eyes (mirror-swap so it reads like a mirror) ---
	let blinkL = v("eyeBlinkLeft");
	let blinkR = v("eyeBlinkRight");
	if (MIRROR) [blinkL, blinkR] = [blinkR, blinkL];
	out.eyeLOpen = clamp(1 - blinkL * 1.2, 0, 1);
	out.eyeROpen = clamp(1 - blinkR * 1.2, 0, 1);

	// --- gaze ---
	const gx =
		(v("eyeLookInLeft") + v("eyeLookOutRight")) / 2 -
		(v("eyeLookOutLeft") + v("eyeLookInRight")) / 2;
	const gy =
		(v("eyeLookUpLeft") + v("eyeLookUpRight")) / 2 -
		(v("eyeLookDownLeft") + v("eyeLookDownRight")) / 2;
	out.eyeBallX = clamp(gx * (MIRROR ? -1 : 1), -1, 1);
	out.eyeBallY = clamp(gy, -1, 1);

	// --- mouth ---
	// Lift small jaw openings so speech is visible, but smoothly: the old fixed
	// +0.3 "baseJaw" caused a pop when jawOpen crossed the threshold. A deadzone
	// kills closed-mouth jitter; the concave curve (pow < 1) amplifies the low
	// end continuously, so there's no discontinuity.
	const JAW_DEADZONE = 0.0045; // ignore sensor noise when the mouth is closed
	const JAW_CURVE = 0.22; // lower = more low-end amplification (speech)
	const JAW_GAIN = 1.1; // reach fully-open a bit sooner
	const jaw = clamp((v("jawOpen") - JAW_DEADZONE) / (1 - JAW_DEADZONE), 0, 1);
	out.mouthOpen = clamp(Math.pow(jaw, JAW_CURVE) * JAW_GAIN, 0, 1);
	out.mouthForm = clamp((v("mouthSmileLeft") + v("mouthSmileRight")) / 2, 0, 1);

	// --- brows ---
	let browL = clamp(v("browInnerUp") - v("browDownLeft"), -1, 1);
	let browR = clamp(v("browInnerUp") - v("browDownRight"), -1, 1);
	// if (MIRROR) [browL, browR] = [browR, browL];
	out.browLY = browL;
	out.browRY = browR;
}

/** Translate a PoseLandmarker result (shoulders) into body-angle rig values. */
function mapPose(pose: any, out: Rig): void {
	const lm = pose.landmarks[0];
	const L = lm[11]; // left shoulder
	const R = lm[12]; // right shoulder
	// Skip if the shoulders aren't confidently visible (e.g. out of frame).
	if ((L.visibility ?? 1) < 0.5 || (R.visibility ?? 1) < 0.5) return;

	const deg = 180 / Math.PI;
	const ms = MIRROR ? -1 : 1;

	// roll: tilt of the shoulder line from horizontal (level shoulders -> 0)
	const rollDeg = Math.atan2(L.y - R.y, L.x - R.x) * deg;
	out.bodyAngleZ = clamp(rollDeg * BODY_ROLL_GAIN * ms, -10, 10);

	// lean / rise: shoulder midpoint shift from the resting baseline (y is down)
	const midX = (L.x + R.x) / 2;
	const midY = (L.y + R.y) / 2;
	if (!poseBaseline) poseBaseline = { x: midX, y: midY };
	out.bodyAngleX = clamp((midX - poseBaseline.x) * BODY_LEAN_GAIN * ms, -10, 10);
	out.bodyAngleY = clamp((poseBaseline.y - midY) * BODY_RISE_GAIN, -10, 10);
}
