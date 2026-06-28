import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Custom scheme for serving Live2D model assets that live OUTSIDE the project root
// (so Vite/file:// can't reach them). The renderer builds URLs as
// `web2dmodel://model/<abs file path>`; pixi-live2d-display resolves a model's
// referenced textures/physics/motions relative to that, so the whole model tree is
// served from disk.
export const MODEL_SCHEME = "web2dmodel";

// Must run before app `ready`. Standard + secure so URL resolution and image/fetch
// loads behave like http.
export function registerModelScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: MODEL_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				stream: true,
				bypassCSP: true,
				corsEnabled: true,
			},
		},
	]);
}

const MIME: Record<string, string> = {
	json: "application/json",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};
const mimeFor = (p: string) => MIME[p.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

// `isAllowed` gates which files may be read, so the renderer can't pull arbitrary
// paths off disk — only files under a resolved model location.
export function handleModelProtocol(isAllowed: (filePath: string) => boolean): void {
	protocol.handle(MODEL_SCHEME, async (request) => {
		const filePath = resolve(decodeURIComponent(new URL(request.url).pathname));
		if (!isAllowed(filePath)) return new Response("forbidden", { status: 403 });
		try {
			const data = await readFile(filePath);
			return new Response(data, {
				headers: { "content-type": mimeFor(filePath), "access-control-allow-origin": "*" },
			});
		} catch {
			return new Response("not found", { status: 404 });
		}
	});
}
