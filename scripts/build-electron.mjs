// Bundles the Electron main + preload (TypeScript) to CommonJS in dist-electron/.
// `.cjs` output keeps them CommonJS regardless of package.json "type": "module".
import { build } from "esbuild";

await build({
	entryPoints: {
		main: "electron/main.ts",
		preload: "electron/preload.ts",
	},
	outdir: "dist-electron",
	outExtension: { ".js": ".cjs" },
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	sourcemap: true,
	// electron + native addons (koffi, the global-hotkey napi module) must stay
	// external and resolve from node_modules at runtime; they can't be bundled.
	external: ["electron", "koffi", "@web2d/global-hotkey"],
});

console.log("built dist-electron/{main,preload}.cjs");
