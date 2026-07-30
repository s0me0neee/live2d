import { defineConfig } from "vite";
import { resolve } from "node:path";

// https://vite.dev/config/
export default defineConfig({
	// Relative base so the built renderer works when Electron loads it over
	// file:// (dist/index.html) in a packaged app.
	base: "./",
	clearScreen: false,
	build: {
		rollupOptions: {
			input: {
				main: resolve(__dirname, "index.html"),
				settings: resolve(__dirname, "settings.html"),
				faceDebug: resolve(__dirname, "face-debug.html"),
			},
		},
	},
	server: {
		port: 1420,
		strictPort: true,
	},
});
