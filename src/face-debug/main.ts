import { FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { FaceResult } from "../face-worker";
import { eyeOffsets, mouthOpenRatio, uniqueIndices, type EyeOffset } from "../face-geometry";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const dotEl = document.getElementById("dot")!;
const statEl = document.getElementById("stat")!;
const readoutEl = document.getElementById("readout")!;
document.getElementById("close")!.addEventListener("click", () => window.close());
let forceRecenter = true; // capture a baseline on the first frame too
document.getElementById("recenter")!.addEventListener("click", () => {
	forceRecenter = true;
});

// Groups of landmark-index connections to draw, straight from the same model the
// main tracking rig already uses — no separate index table to keep in sync.
const GROUPS: { connections: { start: number; end: number }[]; color: string }[] = [
	{ connections: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, color: "#4a90d9" },
	{ connections: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, color: "#4a90d9" },
	{ connections: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, color: "#4a90d9" },
	{ connections: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, color: "#4a90d9" },
	{ connections: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, color: "#4a90d9" },
	{ connections: FaceLandmarker.FACE_LANDMARKS_LIPS, color: "#4a90d9" },
];

let mirror = false;
window.electronAPI
	?.getConfig()
	.then((resolved) => {
		mirror = resolved.config.mirror;
	})
	.catch(() => {});
const mirrorX = (x: number) => (mirror ? 1 - x : x);

function resizeCanvas(): void {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(canvas.clientWidth * dpr);
	canvas.height = Math.round(canvas.clientHeight * dpr);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// The face only fills a small part of the full camera frame at typical webcam
// distances, so mapping the raw [0,1] frame coordinates onto the canvas (the
// previous approach) left the face tiny in a corner. Instead, zoom to a smoothed
// bounding box around the actual landmarks each frame, like VTS's debug view does.
interface Box { x0: number; y0: number; x1: number; y1: number }
let box: Box | null = null;

function updateBox(lm: NormalizedLandmark[]): void {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of lm) {
		const x = mirrorX(p.x);
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (p.y < y0) y0 = p.y;
		if (p.y > y1) y1 = p.y;
	}
	const padX = (x1 - x0) * 0.18;
	const padY = (y1 - y0) * 0.18;
	const raw: Box = { x0: x0 - padX, y0: y0 - padY, x1: x1 + padX, y1: y1 + padY };
	if (!box) {
		box = raw;
		return;
	}
	// Smoothed, not snapped straight to the raw box — otherwise the zoom/pan visibly
	// jitters frame to frame as the detected box edges wobble by a few pixels.
	const a = 0.25;
	box = {
		x0: box.x0 + (raw.x0 - box.x0) * a,
		y0: box.y0 + (raw.y0 - box.y0) * a,
		x1: box.x1 + (raw.x1 - box.x1) * a,
		y1: box.y1 + (raw.y1 - box.y1) * a,
	};
}

// Maps `box` onto the canvas like CSS object-fit: contain, and returns the scale
// factor too (needed to size the gaze line relative to the on-screen eye size).
function transform(): { scale: number; offX: number; offY: number } {
	const dpr = window.devicePixelRatio || 1;
	const cw = canvas.width / dpr;
	const ch = canvas.height / dpr;
	const b = box ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
	const bw = b.x1 - b.x0 || 1;
	const bh = b.y1 - b.y0 || 1;
	const scale = bw / bh > cw / ch ? cw / bw : ch / bh;
	return { scale, offX: (cw - bw * scale) / 2 - b.x0 * scale, offY: (ch - bh * scale) / 2 - b.y0 * scale };
}

function project(x: number, y: number): [number, number] {
	const { scale, offX, offY } = transform();
	return [offX + mirrorX(x) * scale, offY + y * scale];
}

let lastMessageAt = 0;
// Arrival timestamps within the last second. Relayed over renderer→main→debug-window
// IPC, messages don't land evenly spaced (the main process can queue a few and flush
// them back-to-back) — an instantaneous 1/delta reading swings wildly on that jitter,
// so count arrivals over a rolling window instead.
const arrivals: number[] = [];

window.electronAPI?.faceDebug.onData((result: FaceResult) => {
	const now = performance.now();
	lastMessageAt = now;
	arrivals.push(now);
	while (arrivals.length && now - arrivals[0] > 1000) arrivals.shift();
	draw(result);
});

// Flips the status dot back to "lost" between detections (a message only ever
// arrives when a face WAS found — see face-worker.ts — so silence means no face).
setInterval(() => {
	const now = performance.now();
	const tracking = now - lastMessageAt < 400;
	while (arrivals.length && now - arrivals[0] > 1000) arrivals.shift();
	dotEl.classList.toggle("tracking", tracking);
	statEl.textContent = tracking ? `${arrivals.length} FPS` : "no face detected";
}, 200);

// The eye contour's bounding-box center isn't the same point as where the iris
// naturally rests looking straight ahead — eyelid shape is asymmetric and a webcam
// usually sits above eye level, so the raw offset reads with a constant inward/
// downward bias even at a neutral gaze. Captured on the first frame and whenever the
// Recenter button is clicked, then subtracted so the arrow reflects a change from
// neutral. Deliberately NOT re-captured automatically on any timing heuristic (e.g.
// "tracking resumed") — that fired at unpredictable, possibly non-neutral moments,
// which is worse than just letting the user recenter it explicitly on demand.
let baseline: EyeOffset[] | null = null;

function draw(result: FaceResult): void {
	const dpr = window.devicePixelRatio || 1;
	ctx.save();
	ctx.scale(dpr, dpr);
	ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

	const lm = result.landmarks;
	if (!lm) {
		ctx.restore();
		return;
	}
	updateBox(lm);

	const needsBaseline = forceRecenter;
	forceRecenter = false;
	if (needsBaseline) baseline = [];

	for (const { connections, color } of GROUPS) {
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = 1.5;
		for (const { start, end } of connections) {
			const [x1, y1] = project(lm[start].x, lm[start].y);
			const [x2, y2] = project(lm[end].x, lm[end].y);
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
		for (const i of uniqueIndices(connections)) {
			const [x, y] = project(lm[i].x, lm[i].y);
			ctx.beginPath();
			ctx.arc(x, y, 2.5, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	// Per eye: iris center as a dot, plus a ray from it pointing in the gaze
	// direction — the same eyeOffsets() the real tracking rig uses, so this view
	// can never drift from what actually drives the model.
	const { scale } = transform();
	const faceBox = box ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
	const rayLen = (faceBox.x1 - faceBox.x0) * scale * 0.35;
	const clamp1 = (v: number) => Math.min(1, Math.max(-1, v));

	const eyes = eyeOffsets(lm, mirror);
	if (needsBaseline) baseline = eyes;
	const readout: string[] = [];
	eyes.forEach((raw, idx) => {
		const base = baseline![idx];
		const ox = clamp1(raw.ox - base.ox);
		const oy = clamp1(raw.oy - base.oy);
		readout.push(`${idx === 0 ? "L" : "R"} ${ox.toFixed(2)},${oy.toFixed(2)}`);

		const [ix, iy] = project(raw.icx, raw.icy);
		const tipX = ix + ox * rayLen;
		const tipY = iy + oy * rayLen;

		ctx.fillStyle = "#e04a3f";
		ctx.beginPath();
		ctx.arc(ix, iy, 3.5, 0, Math.PI * 2);
		ctx.fill();

		ctx.strokeStyle = "#e04a3f";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(ix, iy);
		ctx.lineTo(tipX, tipY);
		ctx.stroke();

		const angle = Math.atan2(tipY - iy, tipX - ix);
		const headLen = 5;
		ctx.beginPath();
		ctx.moveTo(tipX, tipY);
		ctx.lineTo(tipX - headLen * Math.cos(angle - Math.PI / 6), tipY - headLen * Math.sin(angle - Math.PI / 6));
		ctx.lineTo(tipX - headLen * Math.cos(angle + Math.PI / 6), tipY - headLen * Math.sin(angle + Math.PI / 6));
		ctx.closePath();
		ctx.fill();
	});

	readoutEl.textContent = `mouth ${mouthOpenRatio(lm).toFixed(3)} · gaze ${readout.join(" ")}`;

	ctx.restore();
}
