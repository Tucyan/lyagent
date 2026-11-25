import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const studentApiPort = Number.parseInt(process.env.STUDENT_PORT ?? "3010", 10);
const studentWebPort = Number.parseInt(process.env.STUDENT_WEB_PORT ?? "5174", 10);
const apiOrigin = `http://127.0.0.1:${studentApiPort}`;

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: path.resolve(root, "../dist/web-student"),
    emptyOutDir: true,
  },
  server: {
    port: studentWebPort,
    proxy: {
      "/api": {
        target: apiOrigin,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => proxyRequest.setHeader("origin", apiOrigin));
        },
      },
    },
  },
});
