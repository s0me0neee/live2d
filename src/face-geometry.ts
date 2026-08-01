// Landmark-based (not blendshape-based) face geometry, shared between the real
// tracking rig (face-tracking.ts) and the face-debug visualizer, so the two can
// never drift apart — the debug view's math IS what drives the model.
import { FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface EyeOffset {
	ox: number;
	oy: number;
	// Iris centroid in raw (unmirrored) landmark space — callers that draw the gaze
	// origin (e.g. face-debug) project this themselves; face-tracking.ts ignores it.
	icx: number;
	icy: number;
}

export function uniqueIndices(connections: { start: number; end: number }[]): number[] {
	return [...new Set(connections.flatMap((c) => [c.start, c.end]))];
}

const EYES = [
	{ eye: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, iris: FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS },
	{ eye: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, iris: FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS },
];
const LEFT_EYE_INDICES = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE);
const RIGHT_EYE_INDICES = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE);

function eyeGeometry(
	lm: NormalizedLandmark[],
	eye: { start: number; end: number }[],
	iris: { start: number; end: number }[],
) {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const i of uniqueIndices(eye)) {
		const p = lm[i];
		if (p.x < x0) x0 = p.x;
		if (p.x > x1) x1 = p.x;
		if (p.y < y0) y0 = p.y;
		if (p.y > y1) y1 = p.y;
	}
	const irisIdx = uniqueIndices(iris);
	let sx = 0, sy = 0;
	for (const i of irisIdx) { sx += lm[i].x; sy += lm[i].y; }
	return { icx: sx / irisIdx.length, icy: sy / irisIdx.length, x0, y0, x1, y1 };
}

// Per-eye iris offset from that eye's own socket bbox center, roughly in eye-widths
// (not clamped, no neutral baseline subtracted). Raw signal only: the bbox center is
// biased off true "looking straight ahead" (asymmetric eyelid shape, webcam above eye
// level), so callers must subtract their own captured baseline and average the eyes
// themselves — a rig concern, not a geometry one.
export function eyeOffsets(lm: NormalizedLandmark[], mirror: boolean): [EyeOffset, EyeOffset] {
	return EYES.map(({ eye, iris }) => {
		const g = eyeGeometry(lm, eye, iris);
		const ecx = (g.x0 + g.x1) / 2;
		const ecy = (g.y0 + g.y1) / 2;
		let ox = (g.icx - ecx) / ((g.x1 - g.x0) / 2 || 1);
		const oy = (g.icy - ecy) / ((g.y1 - g.y0) / 2 || 1);
		if (mirror) ox = -ox;
		return { ox, oy, icx: g.icx, icy: g.icy };
	}) as [EyeOffset, EyeOffset];
}

type Point3 = Pick<NormalizedLandmark, "x" | "y" | "z">;

function dist3(a: Point3, b: Point3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function centroid3(lm: NormalizedLandmark[], indices: number[]): Point3 {
	let x = 0, y = 0, z = 0;
	for (const i of indices) { x += lm[i].x; y += lm[i].y; z += lm[i].z; }
	return { x: x / indices.length, y: y / indices.length, z: z / indices.length };
}

// Standard mouth-aspect-ratio (MAR) landmark pair: the inner-lip vertices directly
// above/below mouth center. Verified against this MediaPipe build's actual
// FACE_LANDMARKS_LIPS connections (82-13-312 upper inner arc, 178-87-14-317 lower
// inner arc) rather than assumed from memory.
const UPPER_INNER_LIP = 13;
const LOWER_INNER_LIP = 14;

// Mouth gap over interocular distance, both measured as full 3D landmark-space
// distances (not 2D image-plane ones): a 3D vertex-to-vertex distance on a rigid body
// is unchanged by any pure rotation, so this cancels roll/pitch/yaw contamination that
// a 2D projection can't. The interocular reference uses each eye's vertex centroid
// rather than a bbox center, since which landmark is "extreme" shifts as the head
// turns and would reintroduce a smaller-scale version of the same rotation artifact.
// Trade-off: landmark z is noisier than x/y, and this single point pair lacks the
// averaging a whole-contour spread had — config.jaw.deadzone and render-loop smoothing
// are the intended mitigation; averaging the (82,87)/(312,317) pairs too is the next
// step if live jitter (face-debug's "mouth" readout) proves that insufficient.
export function mouthOpenRatio(lm: NormalizedLandmark[]): number {
	const left = centroid3(lm, LEFT_EYE_INDICES);
	const right = centroid3(lm, RIGHT_EYE_INDICES);
	const interocular = dist3(left, right) || 1;
	return dist3(lm[UPPER_INNER_LIP], lm[LOWER_INNER_LIP]) / interocular;
}
