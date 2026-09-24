import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveApiPort } from "../src/config/api-port.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const apiPort = resolveApiPort(process.env);
const webPort = Number.parseInt(process.env.COURSE_AGENT_WEB_PORT ?? "5173", 10);
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: path.resolve(root, "../dist/web"), emptyOutDir: true },
  server: {
    port: webPort,
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
