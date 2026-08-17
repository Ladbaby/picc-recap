import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		server: {
			deps: {
				// Route @earendil-works packages through Vite so pi-ai resolves to a
				// single instance (shared api-registry) — mirrors picc-subagents.
				inline: [/@earendil-works\/pi-/],
			},
		},
	},
	resolve: {
		dedupe: ["@earendil-works/pi-ai"],
	},
});
