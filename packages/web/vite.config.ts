import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import serviceWorker from "./sw/vite-plugin.mjs";

// In dev, Vite serves the UI with hot reload and forwards the bridge's
// endpoints to it, so the page talks to the bridge exactly as in production.
const BRIDGE = process.env.VBUDDY_BRIDGE ?? "http://localhost:4789";

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    host: true, // reachable from your phone on the LAN during development
    port: 5173,
    proxy: {
      // xfwd: the bridge sees the real device address (it trusts the header only from this PC).
      "/ws": { target: BRIDGE, ws: true, xfwd: true },
      "/api": { target: BRIDGE },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // two pages: the app, and the VBuddy window that opens on the bridge PC
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), console: resolve(import.meta.dirname, "console.html") } },
  },
});
