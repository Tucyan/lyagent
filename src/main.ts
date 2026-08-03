import path from "node:path";
import pino from "pino";
import { createDeepSeekMaterialPlanner } from "./agents/material-import/deepseek.js";
import { createDeepSeekCourseQaAgentFactory } from "./agents/course-qa/deepseek.js";
import { createServer } from "./api/server.js";
import { registerWebAssets } from "./api/web-assets.js";
import { loadAppConfig } from "./config/app-config.js";
import { createDdgsRunner } from "./services/ddgs-process-runner.js";
import { DdgsSearchService } from "./services/ddgs-search-service.js";
import { SafeWebFetcher } from "./services/safe-web-fetcher.js";
import { WebEvidenceService } from "./services/web-evidence-service.js";

const workspaceRoot = path.resolve(process.env.COURSE_AGENT_WORKSPACE ?? "workspace");
const logger = pino({ name: "course-agent", level: process.env.LOG_LEVEL ?? "info" });
const config = await loadAppConfig(workspaceRoot);
const deepseek = createDeepSeekMaterialPlanner(config.deepseekApiKey);
const courseQa = createDeepSeekCourseQaAgentFactory(config.deepseekApiKey);
const ddgs = new DdgsSearchService(createDdgsRunner(undefined, config.webSearch.pythonCommand), { maxResults: config.webSearch.maxResults });
const webFetcher = new SafeWebFetcher();
const app = await createServer({
  workspaceRoot,
  ...(deepseek.planner ? { materialPlanner: deepseek.planner } : {}),
  ...(courseQa.factory ? { courseQaAgentFactory: courseQa.factory } : {}),
  ...(config.webSearch.enabled ? { webEvidenceFactory: () => new WebEvidenceService(ddgs, (url) => webFetcher.fetch(url)) } : {}),
  modelStatus: deepseek.status,
});
await registerWebAssets(app, path.resolve("dist/web"));
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
await app.listen({ host: "127.0.0.1", port });
logger.info({ workspace: workspaceRoot, port, model: deepseek.status }, "course-agent M1 server is ready");
