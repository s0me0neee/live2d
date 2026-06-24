/**
 * Central tuning + performance knobs for the app.
 * Tweak these instead of hunting through the modules.
 */
export const config = {
	// --- model assets ---
	modelDir: "/model/ariu/",
	modelFile: "ariu.model3.json",
	scale: 0.2,

	// --- feel / mirroring ---
	mirror: true, // model reflects you like a mirror; flip if it feels backwards
	smoothing: 0.6, // 0..1 per render frame, higher = snappier head/eyes

	// --- head ---
	headGain: 1.5, // model rotation per degree of head turn
	headClampDeg: 80, // max |head angle|

	// --- body (derived from the head pose) ---
	bodyFollow: 1 / 3, // body lean as a fraction of head angle

	// --- hair physics ---
	// Scales how far the hair swings from rest (the model's physics still drives
	// it from your head motion). 1 = model default, >1 = swingier, <1 = stiffer.
	hairGain: 1.5,

	// --- eyes / mouth ---
	blinkGain: 1.3, // how easily a blink fully closes
	jaw: { deadzone: 0.004, curve: 0.23, gain: 1.1 }, // smooth speech-visible mouth

	// --- performance ---
	// Cap MediaPipe inference rate (its cost dominates). The render/smoothing
	// still runs at full refresh, so lowering this stays smooth but less snappy.
	detectFps: 60,
	camera: { width: 640, height: 480 },
} as const;
