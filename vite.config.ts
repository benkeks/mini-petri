import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative asset paths, so the build works under any subpath (e.g. GitHub Pages project sites).
  base: "./",
  plugins: [VitePWA({
    registerType: "prompt",
    includeAssets: ["icons/mini-petri.svg"],
    manifest: {
      id: "./",
      name: "Mini Petri",
      short_name: "Mini Petri",
      description: "A game about colored Petri nets.",
      start_url: "./",
      scope: "./",
      display: "fullscreen",
      orientation: "landscape",
      background_color: "#f5f0ed",
      theme_color: "#f5f0ed",
      icons: [
        { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
    workbox: {
      globPatterns: ["**/*.{html,js,css,ttf,woff,woff2}"],
    },
  })],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
