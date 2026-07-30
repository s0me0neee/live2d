// MediaPipe inference off the render thread: main transfers the camera's
// VideoFrame stream here; each detection posts back a compact result.
import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface FaceWorkerInit {
	readable: ReadableStream<VideoFrame>;
	detectFps: number;
}

export interface FaceResult {
	blend: Record<string, number>;
	matrix: number[] | null;
	// Drives mouthOpenRatio/eyeOffsets in the tracking rig (face-tracking.ts) as well
	// as the face-debug viewer — computing this is free since MediaPipe already
	// produces it internally to derive the blendshapes.
	landmarks: NormalizedLandmark[] | null;
}

export type FaceWorkerMessage =
	| { type: "ready" }
	| { type: "error"; message: string }
	| ({ type: "result" } & FaceResult);

const post = (msg: FaceWorkerMessage) => postMessage(msg);

onmessage = async (e: MessageEvent<FaceWorkerInit>) => {
	try {
		await run(e.data);
	} catch (err) {
		post({ type: "error", message: String(err) });
	}
};

async function run({ readable, detectFps }: FaceWorkerInit): Promise<void> {
	// Full-origin URL, not "/mediapipe/wasm": Vite's dev transform appends ?import
	// to path-only dynamic imports inside the worker graph, and public-dir files
	// 403 on module import. URLs with a protocol are left untouched.
	const fileset = await FilesetResolver.forVisionTasks(
		new URL("/mediapipe/wasm", self.location.origin).href,
	);
	// The wasm loader is a classic script that declares `var ModuleFactory` — on the
	// main thread MediaPipe injects it via <script>, but in a module worker it can
	// only import() it, which leaves ModuleFactory module-scoped and the global
	// unset ("ModuleFactory not set"). Evaluate it as a classic script instead.
	(0, eval)(await (await fetch(fileset.wasmLoaderPath)).text());
	const landmarker = await FaceLandmarker.createFromOptions(fileset, {
		baseOptions: {
			modelAssetPath: "/mediapipe/face_landmarker.task",
			// Not "CPU": this wasm build's XNNPACK path silently detects nothing
			// (0 faces on a clear face; GPU finds it). The GPU delegate's synchronous
			// glReadPixels stalls are why inference lives in this worker.
			delegate: "GPU",
		},
		runningMode: "VIDEO",
		numFaces: 1,
		outputFaceBlendshapes: true,
		outputFacialTransformationMatrixes: true,
		// Defaults (0.5) drop tracking well before the face actually leaves frame —
		// e.g. a ~20° downward tilt (a normal angle when a webcam sits above the
		// screen) was enough to lose it. Lower thresholds trade a bit of jitter for
		// staying locked on through moderate head angles.
		minFaceDetectionConfidence: 0.3,
		minFacePresenceConfidence: 0.3,
		minTrackingConfidence: 0.3,
	});
	post({ type: "ready" });

	// MediaStreamTrackProcessor buffers only the newest frame, so a slow detection
	// never builds a backlog; frames arriving faster than detectFps are dropped.
	const minInterval = 1000 / detectFps;
	let lastDetect = 0;
	const reader = readable.getReader();
	try {
		for (;;) {
			const { value: frame, done } = await reader.read();
			if (done) return;
			// Every VideoFrame must be closed (even on a detect throw or a drop) or the
			// capture pipeline stalls holding buffers it can't recycle.
			try {
				const now = performance.now();
				if (now - lastDetect < minInterval) continue; // arrived faster than detectFps
				lastDetect = now;
				const res = landmarker.detectForVideo(frame, now);
				if (!res.faceBlendshapes?.length) continue;
				const blend: Record<string, number> = {};
				for (const c of res.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;
				post({
					type: "result",
					blend,
					matrix: res.facialTransformationMatrixes?.[0]?.data ?? null,
					landmarks: res.faceLandmarks?.[0] ?? null,
				});
			} finally {
				frame.close();
			}
		}
	} finally {
		reader.releaseLock();
	}
}
