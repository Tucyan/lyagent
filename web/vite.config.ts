import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: path.resolve(root, "../dist/web"), emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3000" } },
});
