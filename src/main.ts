import path from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { createServer } from "./api/server.js";
import { registerWebAssets } from "./api/web-assets.js";
import { defaultSecretRoot, FileCredentialStore, WindowsDpapiProtector } from "./config/credential-store.js";
import { createConfiguredModels } from "./models/openai-compatible.js";
import { createPrimaryModelRuntime } from "./models/runtime.js";
import { createDdgsRunner } from "./services/ddgs-process-runner.js";
import { DdgsSearchService } from "./services/ddgs-search-service.js";
import { SafeWebFetcher } from "./services/safe-web-fetcher.js";
import { WebEvidenceService } from "./services/web-evidence-service.js";
import { OpenAICompatibleStudentIdentityClient } from "./services/student-identity-service.js";
import { MineruClient } from "./services/mineru-client.js";
import { ModelConfigService } from "./services/model-config-service.js";

const workspaceRoot = path.resolve(process.env.COURSE_AGENT_WORKSPACE ?? "workspace");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const logger = pino({ name: "course-agent", level: process.env.LOG_LEVEL ?? "info" });
const credentialStore = new FileCredentialStore(defaultSecretRoot(), new WindowsDpapiProtector());
const modelConfigService = new ModelConfigService({ workspaceRoot, credentials: credentialStore });
const { config, apiKeys } = await modelConfigService.loadRuntimeConfig();
const primaryApiKey = apiKeys[config.models.primary.providerId];
const configuredModels = createConfiguredModels({ config: config.models, getApiKey: async (providerId) => apiKeys[providerId] });
const ddgs = new DdgsSearchService(createDdgsRunner(undefined, config.webSearch.pythonCommand), { maxResults: config.webSearch.maxResults });
const webFetcher = new SafeWebFetcher();
const webFactory = config.webSearch.enabled ? () => new WebEvidenceService(ddgs, (url) => webFetcher.fetch(url)) : undefined;
const runtime = createPrimaryModelRuntime({ workspaceRoot, configured: configuredModels, ...(primaryApiKey ? { apiKey: primaryApiKey } : {}), ...(webFactory ? { webFactory } : {}) });
const app = await createServer({
  workspaceRoot,
  ...(runtime.materialPlanner ? { materialPlanner: runtime.materialPlanner } : {}),
  ...(runtime.courseQaAgentFactory ? { courseQaAgentFactory: runtime.courseQaAgentFactory } : {}),
  ...(runtime.rubricDesignerFactory ? { rubricDesignerFactory: runtime.rubricDesignerFactory } : {}),
  ...(webFactory ? { webEvidenceFactory: webFactory } : {}),
  ...(primaryApiKey ? { studentIdentityClient: new OpenAICompatibleStudentIdentityClient({ apiKey: primaryApiKey, baseUrl: config.models.primary.baseUrl, model: config.models.primary.modelId }) } : {}),
  mineruConversionClient: new MineruClient({ baseUrl: config.mineru.baseUrl }),
  submissionConversionOptions: { pollIntervalMs: config.mineru.pollIntervalMs, taskTimeoutSeconds: config.mineru.taskTimeoutSeconds, maxAttempts: config.mineru.maxAttempts },
  ...(runtime.gradingAgentFactory ? { gradingAgentFactory: runtime.gradingAgentFactory } : {}),
  ...(runtime.gradingAgentFactory ? { submissionTitleAgentFactory: runtime.gradingAgentFactory } : {}),
  modelStatus: runtime.status,
  modelConfigService,
  modelApiSecurity: {
    csrfToken: process.env.COURSE_AGENT_CSRF_TOKEN ?? randomUUID(),
    allowedOrigin: process.env.COURSE_AGENT_ORIGIN ?? `http://127.0.0.1:${port}`,
    isLoopback: (request) => request.ip === "127.0.0.1" || request.ip === "::1",
  },
});
await registerWebAssets(app, path.resolve("dist/web"));
await app.listen({ host: "127.0.0.1", port });
logger.info({ workspace: workspaceRoot, port, model: runtime.status }, "course-agent server is ready");
