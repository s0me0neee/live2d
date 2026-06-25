/**
 * Model-INDEPENDENT tuning + performance knobs. These drive Cubism-standard
 * parameters / the generic physics + breath runtime, so they work on any
 * Cubism 4 model unchanged. Per-model settings (files, scale, hair/cloth param
 * names) live in model-config.ts.
 */
export const config = {
	// --- feel / mirroring ---
	mirror: true, // model reflects you like a mirror; flip if it feels backwards
	smoothing: 0.6, // 0..1 per render frame, higher = snappier head/eyes

	// --- head (ParamAngleX/Y/Z) ---
	headGain: 1.5, // model rotation per degree of head turn
	headClampDeg: 90, // max |head angle|

	// --- body (ParamBodyAngle*, derived from the head pose) ---
	bodyFollow: 1 / 3, // body lean as a fraction of head angle

	// --- idle "breathing" (built-in natural sway, applied at load) ---
	// Scales the breath sine added to head angle + ParamBreath (which feeds the
	// hair/cloth physics). 1 = model default, >1 = livelier, 0 = dead still.
	breath: 0.2,

	// --- ambient pendulum physics (hair/cloth sim, applied at load) ---
	physics: {
		// Master switch for all wind (steady + gust). false = no breeze at all.
		windEnabled: false,
		// Steady breeze added to every strand. +x = screen-right, +y = up.
		// Small values read as a draft; 0,0 = still. (try wind.x ~0.1)
		wind: { x: 0.03, y: -0.03 },
		// Gust oscillates the wind for a living breeze, on top of `wind`.
		// gust = peak strength, gustHz = gusts per second. gust 0 = steady.
		gust: 0.05,
		gustHz: 0.5,
		// Springiness: multiplies every strand's mobility (bounce / overshoot).
		// 1 = model default, >1 = jigglier, <1 = stiffer. Keep under ~1.6.
		springiness: 1.02,
	},

	// --- eyes / mouth (ParamEye*, ParamMouth*) ---
	blinkGain: 1.4, // how easily a blink fully closes
	jaw: { deadzone: 0.0045, curve: 0.24, gain: 1 }, // smooth speech-visible mouth

	// --- performance ---
	// Cap MediaPipe inference rate (its cost dominates). The render/smoothing
	// still runs at full refresh, so lowering this stays smooth but less snappy.
	detectFps: 60,
	camera: { width: 640, height: 480 },
} as const;
