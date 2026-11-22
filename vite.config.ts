import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths, so the build works under any subpath (e.g. GitHub Pages project sites).
  base: "./",
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
