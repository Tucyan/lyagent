import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const portal = process.argv[2];
if (portal !== "teacher" && portal !== "student") {
  throw new Error("Usage: node scripts/smoke-start.mjs teacher|student");
}

const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const { port } = reservation.address();
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

const workspace = await mkdtemp(path.join(os.tmpdir(), "lyagent-smoke-"));
const env = { ...process.env, PORT: String(port), COURSE_AGENT_WORKSPACE: workspace };
Object.assign(env, { STUDENT_PORT: String(port), STUDENT_HOST: "127.0.0.1", STUDENT_WORKSPACE_ROOT: workspace });
for (const key of Object.keys(env)) {
  if (key.startsWith("STUDENT_MODEL_") || key.startsWith("STUDENT_BOOTSTRAP_ADMIN_") ||
      ["COURSE_AGENT_SUPERVISED", "COURSE_AGENT_RUNTIME_OWNER"].includes(key)) delete env[key];
}
const entry = portal === "teacher" ? "dist/src/main.js" : "dist/src/student-main.js";
const child = spawn(process.execPath, [entry], { env, stdio: "inherit", windowsHide: true });
const closed = new Promise((resolve) => child.once("close", resolve));
let launchError;
child.on("error", (error) => { launchError = error; });

try {
  const base = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Portal exited before startup");
    const health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(750) }).catch(() => undefined);
    if (health?.ok) {
      const status = await health.json();
      healthy = portal === "teacher" ? status.ok === true : status.service === "student-portal";
      if (healthy) break;
    }
    await delay(100);
  }
  if (!healthy) throw new Error("Portal did not become healthy before the timeout");
  const page = await fetch(base, { signal: AbortSignal.timeout(1000) });
  if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) {
    throw new Error("Portal did not serve its built frontend");
  }
  await page.text();
  console.log(portal + " portal startup passed");
} finally {
  child.kill();
  await closed;
  await rm(workspace, { recursive: true, force: true });
}
