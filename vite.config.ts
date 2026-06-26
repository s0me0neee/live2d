import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	// Relative base so the built renderer works when Electron loads it over
	// file:// (dist/index.html) in a packaged app.
	base: "./",
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
	},
});
