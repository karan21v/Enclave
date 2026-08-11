import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const monacoPath = (rel: string) =>
  fileURLToPath(new URL(`../../node_modules/monaco-editor/${rel}`, import.meta.url));

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: [
      // y-monaco imports "monaco-editor/esm/vs/editor/editor.api.js", but
      // monaco 0.56's exports map rewrites that to "./esm/vs/esm/vs/..." which
      // doesn't exist. point it at the real file.
      {
        find: "monaco-editor/esm/vs/editor/editor.api.js",
        replacement: monacoPath("esm/vs/editor/editor.api.js"),
      },
    ],
  },

  // workspace package shipped as TS source, so let vite compile it instead of
  // trying to pre-bundle it as a dependency
  optimizeDeps: { exclude: ["@enclave/crypto"] },

  server: {
    port: 5173,
    proxy: {
      // app is on :5173, api on :3001 -- different origins, so proxy them to
      // look like one. Caddy does this in prod.
      "/api": "http://localhost:3001",
      // ws:true or the Upgrade handshake never gets forwarded
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
