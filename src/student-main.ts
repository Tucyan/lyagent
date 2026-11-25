import path from "node:path";
import pino from "pino";
import { createPiCourseQaAgent } from "./agents/course-qa/agent.js";
import { createConfiguredModels } from "./models/openai-compatible.js";
import { createDdgsRunner } from "./services/ddgs-process-runner.js";
import { DdgsSearchService } from "./services/ddgs-search-service.js";
import { SafeWebFetcher } from "./services/safe-web-fetcher.js";
import { WebEvidenceService } from "./services/web-evidence-service.js";
import { loadStudentServerConfig } from "./student/config.js";
import { createStudentServer, registerStudentWebAssets } from "./student/server.js";

const logger = pino({ name: "course-agent-student", level: process.env.LOG_LEVEL ?? "info" });
const config = loadStudentServerConfig(process.env);

const ddgs = new DdgsSearchService(createDdgsRunner(undefined, config.webSearch.pythonCommand), {
  maxResults: config.webSearch.maxResults,
});
const webFetcher = new SafeWebFetcher();
const webEvidenceFactory = config.webSearch.enabled ? () => new WebEvidenceService(ddgs, (url) => webFetcher.fetch(url)) : undefined;

let courseQaAgentFactory;
if (config.model) {
  const { endpoint, apiKey } = config.model;
  const configured = createConfiguredModels({
    config: { primary: endpoint },
    getApiKey: async (providerId) => (providerId === endpoint.providerId ? apiKey : undefined),
  });
  courseQaAgentFactory = (
    knowledge: Parameters<typeof createPiCourseQaAgent>[0]["knowledge"],
    web?: WebEvidenceService,
  ) =>
    createPiCourseQaAgent({
      models: configured.models,
      model: configured.primary,
      knowledge,
      ...(web ? { web } : {}),
      getApiKey: () => apiKey,
    });
}

const server = await createStudentServer({
  config,
  ...(courseQaAgentFactory ? { courseQaAgentFactory } : {}),
  ...(webEvidenceFactory ? { webEvidenceFactory } : {}),
});
await registerStudentWebAssets(server.app, path.resolve("dist/web-student"));

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await server.app.listen({ host: config.host, port: config.port });
logger.info(
  {
    host: config.host,
    port: config.port,
    workspace: config.workspaceRoot,
    modelConfigured: Boolean(courseQaAgentFactory),
  },
  "student-portal server is ready",
);
