import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on :4040; prod: nginx serves dist/ and proxies /v1, /health, /openapi.json to the API (same origin).
export default defineConfig({
  plugins: [react()],
  // The private-key test wallet (src/testWallet.ts) is compiled out of public builds: the flag is a build-time literal, so `if (import.meta.env.VITE_TEST_WALLET === "1")`
  // and the dynamic import behind it are dead code unless the build (or dev server) runs with VITE_TEST_WALLET=1.
  define: { "import.meta.env.VITE_TEST_WALLET": JSON.stringify(process.env.VITE_TEST_WALLET === "1" ? "1" : "") },
  // Dual network (design v3.2 P2): the root API is the site's default network; a second instance answers under /testnet (nginx strips the prefix in prod).
  server: { proxy: { "/testnet": { target: "http://127.0.0.1:4041", rewrite: (path) => path.replace(/^\/testnet/, "") }, "/v1": "http://127.0.0.1:4040", "/health": "http://127.0.0.1:4040", "/openapi.json": "http://127.0.0.1:4040" } },
  build: { outDir: "dist", sourcemap: false, target: "es2022", chunkSizeWarningLimit: 1500 },
});
