import type { Config } from "./config";
import type { FaceResult, FaceWorkerInit, FaceWorkerMessage } from "./face-worker";
import { eyeOffsets, mouthOpenRatio, type EyeOffset } from "./face-geometry";
import { clamp, type Rig, type RigDriver } from "./rig";

// Throws if the camera is denied/unavailable or the worker's landmarker fails to
// initialize, so the caller can run without tracking.
export async function startFaceTracking(driver: RigDriver, config: Config): Promise<void> {
	const track = await openCamera(config);
	const worker = await startDetectionWorker(track, config);

	// Neutral head-pose reference: captured on the first frame and subtracted so
	// the model faces forward at the user's natural pose. The tray "recenter"
	// option re-captures it.
	const calibration: HeadCalibration = { yaw: 0, pitch: 0, roll: 0, captured: false, recenter: false };
	const gazeCalibration: GazeCalibration = { baseline: null, recenter: false };
	window.electronAPI?.faceTracking?.onRecenter(() => {
		console.info("[face] recenter requested — recapturing neutral head pose");
		calibration.recenter = true;
		gazeCalibration.recenter = true;
	});

	worker.onmessage = (e: MessageEvent<FaceWorkerMessage>) => {
		if (e.data.type !== "result") return;
		mapResult(e.data, driver.pose, config, calibration, gazeCalibration);
		driver.markFaceFresh();
		// No-op unless the face-debug window is open (electron/face-debug-window.ts).
		window.electronAPI?.faceDebug?.send(e.data);
	};
	// A worker crash after init would otherwise be silent — the model just freezes at
	// its last pose. Surface it and release the camera so the webcam light turns off.
	// The rig needs no notification: results stop, so it goes stale and the cursor takes over.
	worker.onerror = (e) => {
		console.warn("[face] worker crashed, tracking stopped:", e.message);
		worker.terminate();
		track.stop();
	};
}

interface HeadCalibration {
	yaw: number;
	pitch: number;
	roll: number;
	captured: boolean;
	recenter: boolean;
}

// Kept separate from HeadCalibration rather than added fields on it: that one's
// capture is gated on res.matrix being present, this one on res.landmarks — the two
// can be null independently per frame, so a shared `recenter` flag risks one guard
// consuming it on a frame where the other's required input is missing, silently
// skipping that calibration's recapture. `baseline: null` doubles as "uncaptured"
// (unlike yaw/pitch/roll, 0 isn't a valid captured gaze baseline).
interface GazeCalibration {
	baseline: [EyeOffset, EyeOffset] | null;
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

function mapResult(
	res: FaceResult,
	out: Rig,
	config: Config,
	cal: HeadCalibration,
	gazeCal: GazeCalibration,
): void {
	const v = (name: string) => res.blend[name] ?? 0;

	const { mirror, headGain, eyes: ec, jaw: jc } = config;
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

		// Unclamped — the rig driver applies headClampDeg to whichever source is driving.
		out.angleX = (yaw - cal.yaw) * ms * headGain;
		out.angleY = -(pitch - cal.pitch) * headGain;
		out.angleZ = -(roll - cal.roll) * ms * headGain;
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

	// Gaze and mouth-open come from landmark geometry, not blendshapes — jawOpen and
	// eyeLookIn/Out/Up/Down both misread under head pitch (e.g. jawOpen falsely fires
	// when looking down), whereas these are direct measurements off the face mesh.
	// mouthOpenRatio specifically is defined entirely in 3D landmark space (see
	// face-geometry.ts) so it's invariant to head rotation on all three axes, not just
	// pitch.
	// Guarded like the head-pose matrix above: if landmarks are missing this frame,
	// leave these Rig fields at their previous value rather than snapping to 0.
	if (res.landmarks) {
		const lm = res.landmarks;

		const [left, right] = eyeOffsets(lm, mirror); // mirror already applied inside — don't also multiply by `ms`
		if (!gazeCal.baseline || gazeCal.recenter) {
			gazeCal.baseline = [left, right];
			gazeCal.recenter = false;
		}
		const [baseL, baseR] = gazeCal.baseline;
		const gx = (left.ox - baseL.ox + (right.ox - baseR.ox)) / 2;
		const gy = (left.oy - baseL.oy + (right.oy - baseR.oy)) / 2;
		out.eyeBallX = gx * ec.gazeGain;
		out.eyeBallY = gy * ec.gazeGain;

		// Deadzone kills closed-mouth jitter; curve reshapes; gain scales the result.
		const ratio = mouthOpenRatio(lm);
		const d = clamp((ratio - jc.deadzone) / (jc.openMax - jc.deadzone || 1), 0, 1);
		out.mouthOpen = clamp(Math.pow(d, jc.curve) * jc.gain, 0, 1);
	}
	out.mouthForm = clamp((v("mouthSmileLeft") + v("mouthSmileRight")) / 2, 0, 1);

	out.browLY = clamp(v("browInnerUp") - v("browDownLeft"), -1, 1);
	out.browRY = clamp(v("browInnerUp") - v("browDownRight"), -1, 1);
}
