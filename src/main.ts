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
import { DoclingClient } from "./services/docling-client.js";
import { ModelConfigService } from "./services/model-config-service.js";
import { resolveWorkspaceIdentity } from "./config/workspace-identity.js";

const workspaceIdentity = await resolveWorkspaceIdentity(path.resolve(process.env.COURSE_AGENT_WORKSPACE ?? "workspace"));
const workspaceRoot = workspaceIdentity.canonicalRoot;
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const mineruBackend = process.env.COURSE_AGENT_MINERU_BACKEND === "hybrid-engine" ? "hybrid-engine" : "pipeline";
const logger = pino({ name: "course-agent", level: process.env.LOG_LEVEL ?? "info" });
const credentialStore = new FileCredentialStore(defaultSecretRoot(workspaceIdentity.hash), new WindowsDpapiProtector());
const modelConfigService = new ModelConfigService({ workspaceRoot, credentials: credentialStore });
const { config, apiKeys } = await modelConfigService.loadRuntimeConfig();
const mineruPort = Number.parseInt(process.env.COURSE_AGENT_MINERU_PORT ?? (new URL(config.mineru.baseUrl).port || "8000"), 10);
const primaryApiKey = apiKeys[config.models.primary.providerId];
const visionApiKey = config.models.vision ? apiKeys[config.models.vision.providerId] : undefined;
const configuredModels = createConfiguredModels({ config: config.models, getApiKey: async (providerId) => apiKeys[providerId] });
const ddgs = new DdgsSearchService(createDdgsRunner(undefined, config.webSearch.pythonCommand), { maxResults: config.webSearch.maxResults });
const webFetcher = new SafeWebFetcher();
const webFactory = config.webSearch.enabled ? () => new WebEvidenceService(ddgs, (url) => webFetcher.fetch(url)) : undefined;
const runtime = createPrimaryModelRuntime({ workspaceRoot, configured: configuredModels, ...(primaryApiKey ? { apiKey: primaryApiKey } : {}), ...(visionApiKey ? { visionApiKey } : {}), ...(webFactory ? { webFactory } : {}) });
const app = await createServer({
  workspaceRoot,
  ...(runtime.materialPlanner ? { materialPlanner: runtime.materialPlanner } : {}),
  ...(runtime.courseQaAgentFactory ? { courseQaAgentFactory: runtime.courseQaAgentFactory } : {}),
  ...(runtime.rubricDesignerFactory ? { rubricDesignerFactory: runtime.rubricDesignerFactory } : {}),
  ...(webFactory ? { webEvidenceFactory: webFactory } : {}),
  ...(primaryApiKey ? { studentIdentityClient: new OpenAICompatibleStudentIdentityClient({ apiKey: primaryApiKey, baseUrl: config.models.primary.baseUrl, model: config.models.primary.modelId }) } : {}),
  mineruConversionClient: new DoclingClient({ baseUrl: process.env.COURSE_AGENT_MINERU_PORT ? `http://127.0.0.1:${mineruPort}` : config.mineru.baseUrl }),
  submissionConversionOptions: { pollIntervalMs: config.mineru.pollIntervalMs, taskTimeoutSeconds: config.mineru.taskTimeoutSeconds, maxAttempts: config.mineru.maxAttempts },
  ...(runtime.gradingAgentFactory ? { gradingAgentFactory: runtime.gradingAgentFactory } : {}),
  ...(runtime.gradingAgentFactory ? { submissionTitleAgentFactory: runtime.gradingAgentFactory } : {}),
  modelStatus: runtime.status,
  modelConfigService,
  runtimeStatus: { appVersion: "0.1.0", appPort: port, mineru: { status: "ready", backend: mineruBackend, port: mineruPort }, workspaceConfigured: Boolean(primaryApiKey) },
  ...(process.env.COURSE_AGENT_SUPERVISED === "1" ? { requestRestart: () => { void app.close().finally(() => process.exit(42)); } } : {}),
  ...(process.env.COURSE_AGENT_RUNTIME_OWNER ? { runtimeOwnerToken: process.env.COURSE_AGENT_RUNTIME_OWNER } : {}),
  modelApiSecurity: {
    csrfToken: process.env.COURSE_AGENT_CSRF_TOKEN ?? randomUUID(),
    allowedOrigin: process.env.COURSE_AGENT_ORIGIN ?? `http://127.0.0.1:${port}`,
    isLoopback: (request) => request.ip === "127.0.0.1" || request.ip === "::1",
  },
});
await registerWebAssets(app, path.resolve("dist/web"));
await app.listen({ host: "127.0.0.1", port });
logger.info({ workspace: workspaceRoot, port, model: runtime.status }, "course-agent server is ready");
