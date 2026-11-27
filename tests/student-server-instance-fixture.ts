import { loadStudentServerConfig } from "../src/student/config.js";
import { createStudentServer } from "../src/student/server.js";

try {
  const server = await createStudentServer({
    config: loadStudentServerConfig({ STUDENT_WORKSPACE_ROOT: process.argv[2] }),
  });
  const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
  let ledgerId: string | undefined;
  if (process.argv[3] === "reserve") {
    const { user } = await server.auth.createInitialTeacher({
      username: "teacher",
      password: "Password123",
      displayName: "Teacher",
    });
    ledgerId = server.quotas.reserveQuota({ userId: user.id, courseId: "course", sessionId: "session" });
  }
  process.on("message", async (message) => {
    if (message === "close") {
      await server.app.close();
      process.send?.({ status: "closed" });
    }
  });
  process.send?.({ status: "ready", address, ledgerId });
} catch (error) {
  process.send?.({ status: "failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  process.disconnect?.();
}
