import type { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { Config, ModelConfig } from "./config";
import type { FaceResult, FaceWorkerInit, FaceWorkerMessage } from "./face-worker";

// The Live2D parameters we drive from the webcam (with their value ranges).
interface Rig {
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

const neutral = (): Rig => ({
	angleX: 0, angleY: 0, angleZ: 0,
	eyeLOpen: 1, eyeROpen: 1,
	eyeBallX: 0, eyeBallY: 0,
	mouthOpen: 0, mouthForm: 0,
	browLY: 0, browRY: 0,
});

// Precomputed so the per-frame smoothing loop allocates nothing.
const RIG_KEYS = Object.keys(neutral()) as (keyof Rig)[];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Throws if the camera is denied/unavailable or the worker's landmarker fails to
// initialize, so the caller can run without tracking.
export async function startFaceTracking(
	model: Live2DModel,
	config: Config,
	modelConfig: ModelConfig,
): Promise<void> {
	const track = await openCamera(config);
	const worker = await startDetectionWorker(track, config);

	const target = neutral(); // latest detection
	const rig = neutral(); // smoothed values actually applied

	// Neutral head-pose reference: captured on the first frame and subtracted so
	// the model faces forward at the user's natural pose. The tray "recenter"
	// option re-captures it.
	const calibration: HeadCalibration = { yaw: 0, pitch: 0, roll: 0, captured: false, recenter: false };
	window.electronAPI?.faceTracking?.onRecenter(() => {
		console.info("[face] recenter requested — recapturing neutral head pose");
		calibration.recenter = true;
	});

	worker.onmessage = (e: MessageEvent<FaceWorkerMessage>) => {
		if (e.data.type === "result") mapResult(e.data, target, config, calibration);
	};
	// A worker crash after init would otherwise be silent — the model just freezes at
	// its last pose. Surface it and release the camera so the webcam light turns off.
	worker.onerror = (e) => {
		console.warn("[face] worker crashed, tracking stopped:", e.message);
		worker.terminate();
		track.stop();
	};
	driveModel(model, rig, target, config, modelConfig);
}

interface HeadCalibration {
	yaw: number;
	pitch: number;
	roll: number;
	captured: boolean;
	recenter: boolean;
}

async function openCamera(config: Config): Promise<MediaStreamTrack> {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			video: { ...config.camera, facingMode: "user" },
			audio: false,
		});
		return stream.getVideoTracks()[0];
	} catch (err) {
		// A raw DOMException logs as "[object DOMException]", which says nothing about
		// whether the camera was denied, missing or busy.
		throw new Error(`camera unavailable — ${await describeCameraFailure(err)}`);
	}
}

async function describeCameraFailure(err: unknown): Promise<string> {
	const name = err instanceof DOMException ? err.name : "Error";
	const message = err instanceof Error ? err.message : String(err);
	const cams = await navigator.mediaDevices
		.enumerateDevices()
		.then((ds) => ds.filter((d) => d.kind === "videoinput").length)
		.catch(() => -1);
	return `${name}: ${message} (${cams < 0 ? "device list unavailable" : `${cams} video input(s) detected`})`;
}

// Inference happens in a worker so detectForVideo can never stall the render
// thread; the camera frames are transferred to it as a stream. On init failure the
// worker is dropped and the camera released so the webcam light turns off.
async function startDetectionWorker(track: MediaStreamTrack, config: Config): Promise<Worker> {
	const worker = new Worker(new URL("./face-worker.ts", import.meta.url), { type: "module" });
	const processor = new MediaStreamTrackProcessor({ track });
	const init: FaceWorkerInit = { readable: processor.readable, detectFps: config.detectFps };
	worker.postMessage(init, [init.readable]);

	try {
		await new Promise<void>((resolve, reject) => {
			worker.addEventListener(
				"message",
				(e: MessageEvent<FaceWorkerMessage>) => {
					if (e.data.type === "ready") resolve();
					else reject(new Error(e.data.type === "error" ? e.data.message : "unexpected worker message"));
				},
				{ once: true },
			);
			worker.addEventListener("error", (e) => reject(new Error(e.message)));
		});
	} catch (err) {
		worker.terminate();
		track.stop();
		throw err;
	}
	return worker;
}

// Smooths `rig` toward `target` and writes parameters. Face params go on
// afterMotionUpdate (so the hair/cloth physics reacts to them); body + gain params
// go on beforeModelUpdate (after physics, which would otherwise clobber them).
function driveModel(
	model: Live2DModel,
	rig: Rig,
	target: Rig,
	config: Config,
	modelConfig: ModelConfig,
): void {
	const internal = model.internalModel as any;
	const cm = internal.coreModel;
	internal.eyeBlink = undefined; // we drive the eyes ourselves
	(model as any).automator.autoFocus = false; // stop following the mouse

	const set = (id: string, v: number) => cm.setParameterValueById(id, v);
	const head = modelConfig.headAngle;

	internal.on("afterMotionUpdate", () => {
		for (const k of RIG_KEYS) rig[k] += (target[k] - rig[k]) * config.smoothing;

		set(head.x, rig.angleX);
		set(head.y, rig.angleY);
		set(head.z, rig.angleZ);
		set("ParamEyeLOpen", rig.eyeLOpen);
		set("ParamEyeROpen", rig.eyeROpen);
		set("ParamEyeBallX", rig.eyeBallX);
		set("ParamEyeBallY", rig.eyeBallY);
		set("ParamMouthOpenY", rig.mouthOpen);
		set("ParamMouthForm", rig.mouthForm);
		set("ParamBrowLY", rig.browLY);
		set("ParamBrowRY", rig.browRY);
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
}

function mapResult(res: FaceResult, out: Rig, config: Config, cal: HeadCalibration): void {
	const v = (name: string) => res.blend[name] ?? 0;

	const { mirror, headGain, headClampDeg: lim, eyes: ec, jaw: jc } = config;
	const ms = mirror ? -1 : 1;

	// Head pose from the 4x4 facial transformation matrix (column-major), made
	// relative to the captured neutral reference.
	const m = res.matrix;
	if (m) {
		const r = (row: number, col: number) => m[col * 4 + row];
		const deg = 180 / Math.PI;
		const yaw = Math.atan2(r(0, 2), r(2, 2)) * deg;
		const pitch = Math.atan2(-r(1, 2), Math.hypot(r(0, 2), r(2, 2))) * deg;
		const roll = Math.atan2(r(1, 0), r(1, 1)) * deg;

		if (!cal.captured || cal.recenter) {
			cal.yaw = yaw;
			cal.pitch = pitch;
			cal.roll = roll;
			cal.captured = true;
			cal.recenter = false;
		}

		out.angleX = clamp((yaw - cal.yaw) * ms * headGain, -lim, lim);
		out.angleY = clamp(-(pitch - cal.pitch) * headGain, -lim, lim);
		out.angleZ = clamp(-(roll - cal.roll) * ms * headGain, -lim, lim);
	}

	// Eyes — mirror-swap so it reads like a mirror. Blink is shaped like the jaw:
	// deadzone drops eyelid jitter, the curve reshapes partial blinks, gain scales
	// the close amount.
	let blinkL = v("eyeBlinkLeft");
	let blinkR = v("eyeBlinkRight");
	if (mirror) [blinkL, blinkR] = [blinkR, blinkL];
	const closeAmount = (raw: number) => {
		const d = clamp((raw - ec.deadzone) / (1 - ec.deadzone), 0, 1);
		return Math.pow(d, ec.curve) * ec.gain;
	};
	out.eyeLOpen = clamp(1 - closeAmount(blinkL), 0, 2);
	out.eyeROpen = clamp(1 - closeAmount(blinkR), 0, 2);

	const gx =
		(v("eyeLookInLeft") + v("eyeLookOutRight")) / 2 -
		(v("eyeLookOutLeft") + v("eyeLookInRight")) / 2;
	const gy =
		(v("eyeLookUpLeft") + v("eyeLookUpRight")) / 2 -
		(v("eyeLookDownLeft") + v("eyeLookDownRight")) / 2;
	out.eyeBallX = clamp(gx * ms * ec.gazeGain, -1, 1);
	out.eyeBallY = clamp(gy * ec.gazeGain, -1, 1);

	// Deadzone kills closed-mouth jitter; the concave curve lifts speech.
	const jaw = clamp((v("jawOpen") - jc.deadzone) / (1 - jc.deadzone), 0, 1);
	out.mouthOpen = clamp(Math.pow(jaw, jc.curve) * jc.gain, 0, 1);
	out.mouthForm = clamp((v("mouthSmileLeft") + v("mouthSmileRight")) / 2, 0, 1);

	out.browLY = clamp(v("browInnerUp") - v("browDownLeft"), -1, 1);
	out.browRY = clamp(v("browInnerUp") - v("browDownRight"), -1, 1);
}
