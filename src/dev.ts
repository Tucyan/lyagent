import { randomUUID } from "node:crypto";

process.env.COURSE_AGENT_SUPERVISED = "1";
process.env.COURSE_AGENT_RUNTIME_OWNER = randomUUID();

await import("./main.js");
