import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on :4040; prod: nginx serves dist/ and proxies /v1, /health, /openapi.json to the API (same origin).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/v1": "http://127.0.0.1:4040", "/health": "http://127.0.0.1:4040", "/openapi.json": "http://127.0.0.1:4040" } },
  build: { outDir: "dist", sourcemap: false, target: "es2022", chunkSizeWarningLimit: 1500 },
});
