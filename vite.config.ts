import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  root: "src/frontend",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    // Dev-only convenience: `vite dev` proxies API calls to the bun server,
    // so cookies stay same-origin. Production serves dist from the API.
    proxy: {
      "/api": "http://localhost:7777",
      "/health": "http://localhost:7777",
      "/docs": "http://localhost:7777",
    },
  },
});
