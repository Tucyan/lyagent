import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    reporters: ["dot"],
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
  },
});
