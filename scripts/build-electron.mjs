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
	// electron + koffi (native addon) must stay external and resolve from
	// node_modules at runtime; they can't be bundled.
	external: ["electron", "koffi"],
});

console.log("built dist-electron/{main,preload}.cjs");
