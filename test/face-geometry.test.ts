import { describe, expect, test } from "bun:test";
import { FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { eyeOffsets, mouthOpenRatio, uniqueIndices } from "../src/face-geometry";

const LANDMARK_COUNT = 478;
const LEFT_EYE = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE);
const RIGHT_EYE = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE);
const LEFT_IRIS = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS);
const RIGHT_IRIS = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS);

type Vec3 = { x: number; y: number; z: number };

const blankFace = (): NormalizedLandmark[] =>
	Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));

function place(lm: NormalizedLandmark[], indices: number[], at: (k: number) => Vec3) {
	indices.forEach((i, k) => Object.assign(lm[i], at(k)));
}

// Corners give an exact bbox; evenly spaced ring points give an exact centroid.
const boxCorners = (c: Vec3, halfW: number, halfH: number) => (k: number): Vec3 => ({
	x: c.x + (k % 2 ? halfW : -halfW),
	y: c.y + ((k >> 1) % 2 ? halfH : -halfH),
	z: c.z,
});
const ring = (c: Vec3, r: number, n: number) => (k: number): Vec3 => ({
	x: c.x + r * Math.cos((2 * Math.PI * k) / n),
	y: c.y + r * Math.sin((2 * Math.PI * k) / n),
	z: c.z,
});

function faceWithIris(leftIris: Vec3, rightIris: Vec3) {
	const lm = blankFace();
	place(lm, LEFT_EYE, boxCorners({ x: 0.6, y: 0.4, z: 0 }, 0.05, 0.02));
	place(lm, RIGHT_EYE, boxCorners({ x: 0.4, y: 0.4, z: 0 }, 0.05, 0.02));
	place(lm, LEFT_IRIS, () => leftIris);
	place(lm, RIGHT_IRIS, () => rightIris);
	return lm;
}

function rotate(p: Vec3, yaw: number, pitch: number): Vec3 {
	const x1 = p.x * Math.cos(yaw) + p.z * Math.sin(yaw);
	const z1 = -p.x * Math.sin(yaw) + p.z * Math.cos(yaw);
	return { x: x1, y: p.y * Math.cos(pitch) - z1 * Math.sin(pitch), z: p.y * Math.sin(pitch) + z1 * Math.cos(pitch) };
}

describe("uniqueIndices", () => {
	test("dedupes connection endpoints in first-seen order", () => {
		expect(uniqueIndices([{ start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 1 }])).toEqual([1, 2, 3]);
	});
});

describe("eyeOffsets", () => {
	test("is zero with each iris centered in its socket", () => {
		const [left, right] = eyeOffsets(faceWithIris({ x: 0.6, y: 0.4, z: 0 }, { x: 0.4, y: 0.4, z: 0 }), false);
		for (const eye of [left, right]) {
			expect(eye.ox).toBeCloseTo(0, 9);
			expect(eye.oy).toBeCloseTo(0, 9);
		}
		expect(left.icx).toBeCloseTo(0.6, 9);
	});

	test("measures the offset in half-socket widths and heights", () => {
		const [left] = eyeOffsets(faceWithIris({ x: 0.65, y: 0.39, z: 0 }, { x: 0.4, y: 0.4, z: 0 }), false);
		expect(left.ox).toBeCloseTo(1, 9);
		expect(left.oy).toBeCloseTo(-0.5, 9);
	});

	test("mirroring flips only the horizontal offset", () => {
		const lm = faceWithIris({ x: 0.625, y: 0.41, z: 0 }, { x: 0.4, y: 0.4, z: 0 });
		const [plain] = eyeOffsets(lm, false);
		const [mirrored] = eyeOffsets(lm, true);
		expect(mirrored.ox).toBeCloseTo(-plain.ox, 9);
		expect(mirrored.oy).toBeCloseTo(plain.oy, 9);
	});
});

describe("mouthOpenRatio", () => {
	function face(transform: (p: Vec3) => Vec3 = (p) => p) {
		const lm = blankFace();
		place(lm, LEFT_EYE, (k) => transform(ring({ x: 0.1, y: 0, z: 0 }, 0.02, LEFT_EYE.length)(k)));
		place(lm, RIGHT_EYE, (k) => transform(ring({ x: -0.1, y: 0, z: 0 }, 0.02, RIGHT_EYE.length)(k)));
		Object.assign(lm[13], transform({ x: 0, y: 0.15, z: 0.01 }));
		Object.assign(lm[14], transform({ x: 0, y: 0.2, z: 0.01 }));
		return lm;
	}

	test("is the inner-lip gap over interocular distance", () => {
		expect(mouthOpenRatio(face())).toBeCloseTo(0.25, 9);
	});

	test("is unchanged by head rotation", () => {
		expect(mouthOpenRatio(face((p) => rotate(p, 0.6, -0.4)))).toBeCloseTo(0.25, 9);
	});
});
