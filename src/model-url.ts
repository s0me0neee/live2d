// Builds a URL for a model asset served by the main process's custom scheme (see
// electron/model-protocol.ts). `absDir` is the model's resolved absolute directory;
// `file` is a path relative to it. Each path segment is encoded so non-ASCII names
// and spaces survive.
const SCHEME = "web2dmodel";

export function modelAssetUrl(absDir: string, file: string): string {
	// absDir may be a Windows path (backslashes); splitting/encoding below assumes "/".
	const posixDir = absDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const full = `${posixDir}/${file}`;
	const encoded = full.split("/").map(encodeURIComponent).join("/");
	return `${SCHEME}://model${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}
