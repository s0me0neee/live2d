// Move/resize guide for the overlay window, shown only while unlocked. The
// frameless focusable:false window has no native title bar / resize borders, so
// we drive it from the renderer: read the bounds at grab time, then translate the
// pointer's GLOBAL screenX/Y movement (unaffected by the window moving under the
// cursor) into new bounds. No-op outside Electron or on Wayland, where the window is
// natively resizable instead (Wayland clients can't self-position for the move).

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

type WindowControls = NonNullable<Window["electronAPI"]>["windowControls"];

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

const MIN_W = 200;
const MIN_H = 150;

export function setupWindowControls(): void {
	const api = window.electronAPI;
	if (!api?.windowControls) return;
	// Off on Wayland: the window is natively resizable there and the renderer guide's
	// global-cursor move/setBounds path doesn't work under Wayland (no global
	// coordinates, no self-positioning). macOS, Windows and X11 Linux keep it.
	if (api.isWayland) return;

	const wc = api.windowControls;
	const { root, bar, handles } = buildGuide();
	document.body.appendChild(root);

	// Hidden when locked: click-through would make it unreachable and it would
	// just paint over the game. Lock state comes from main (tray / hotkey / IPC).
	const setShown = (locked: boolean) => {
		root.style.display = locked ? "none" : "block";
	};
	api.overlay.getLock().then(setShown).catch(() => setShown(false));
	api.overlay.onLockChanged(setShown);

	// Drag bar moves the window; corner handles resize it.
	wireDrag(bar, wc, (b, dx, dy) => ({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }));
	for (const corner of CORNERS) {
		wireDrag(handles[corner], wc, (b, dx, dy) => resize(corner, b, dx, dy));
	}
}

// New bounds for dragging `corner` by (dx, dy), keeping the far corner fixed.
function resize(corner: Corner, b: Bounds, dx: number, dy: number): Bounds {
	let { x, y, width, height } = b;
	if (corner.includes("e")) width = b.width + dx;
	if (corner.includes("s")) height = b.height + dy;
	if (corner.includes("w")) {
		x = b.x + dx;
		width = b.width - dx;
	}
	if (corner.includes("n")) {
		y = b.y + dy;
		height = b.height - dy;
	}
	if (width < MIN_W) {
		if (corner.includes("w")) x = b.x + b.width - MIN_W; // pin the far edge
		width = MIN_W;
	}
	if (height < MIN_H) {
		if (corner.includes("n")) y = b.y + b.height - MIN_H;
		height = MIN_H;
	}
	return { x, y, width, height };
}

// Snapshot bounds + global cursor on pointerdown, feed (start, dx, dy) through
// `compute` on move, push the result coalesced to one setBounds per frame.
function wireDrag(
	el: HTMLElement,
	wc: WindowControls,
	compute: (start: Bounds, dx: number, dy: number) => Bounds,
): void {
	let start: { sx: number; sy: number; bounds: Bounds } | null = null;
	let raf = 0;
	let pending: Bounds | null = null;

	const flush = () => {
		raf = 0;
		if (pending) {
			wc.setBounds(pending);
			pending = null;
		}
	};

	el.addEventListener("pointerdown", async (e) => {
		e.preventDefault();
		e.stopPropagation(); // don't let Pixi treat this as a model grab
		try {
			el.setPointerCapture(e.pointerId);
		} catch {
			// best-effort; the window tracks the cursor without capture
		}
		const bounds = await wc.getBounds();
		if (bounds) start = { sx: e.screenX, sy: e.screenY, bounds };
	});

	el.addEventListener("pointermove", (e) => {
		if (!start) return;
		pending = compute(start.bounds, e.screenX - start.sx, e.screenY - start.sy);
		if (!raf) raf = requestAnimationFrame(flush);
	});

	const end = (e: PointerEvent) => {
		if (!start) return;
		start = null;
		try {
			el.releasePointerCapture(e.pointerId);
		} catch {
			// already released
		}
	};
	el.addEventListener("pointerup", end);
	el.addEventListener("pointercancel", end);
}

function buildGuide(): {
	root: HTMLDivElement;
	bar: HTMLDivElement;
	handles: Record<Corner, HTMLDivElement>;
} {
	const root = document.createElement("div");
	root.id = "window-guide";

	const bar = document.createElement("div");
	bar.className = "wg-bar";
	bar.textContent = "⠿  drag to move  ·  pull a corner to resize";
	root.appendChild(bar);

	const handles = {} as Record<Corner, HTMLDivElement>;
	for (const corner of CORNERS) {
		const h = document.createElement("div");
		h.className = `wg-handle wg-${corner}`;
		root.appendChild(h);
		handles[corner] = h;
	}

	return { root, bar, handles };
}
