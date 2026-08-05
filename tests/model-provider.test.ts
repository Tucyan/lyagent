import { expect, it } from "vitest";
import { createConfiguredModels } from "../src/models/openai-compatible.js";
import { createPrimaryModelRuntime } from "../src/models/runtime.js";

it("reuses built-in DeepSeek metadata while overriding endpoint and provider", async () => {
  const configured = createConfiguredModels({
    config: { primary: { providerId: "campus", modelId: "deepseek-v4-flash", baseUrl: "https://gateway.example/v1" } },
    getApiKey: async (providerId) => providerId === "campus" ? "primary-key" : undefined,
  });
  expect(configured.primary).toMatchObject({ provider: "campus", id: "deepseek-v4-flash", baseUrl: "https://gateway.example/v1", input: ["text"] });
  await expect(configured.getApiKey("campus")).resolves.toBe("primary-key");
});

it("uses safe zero-cost fallback metadata and image input for unknown vision models", () => {
  const configured = createConfiguredModels({
    config: {
      primary: { providerId: "custom", modelId: "unknown-chat", baseUrl: "https://api.example/v1" },
      vision: { providerId: "vision", modelId: "unknown-vision", baseUrl: "https://vision.example/v1" },
    },
    getApiKey: async () => undefined,
  });
  expect(configured.primary).toMatchObject({ contextWindow: 128000, maxTokens: 8192, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: ["text"] });
  expect(configured.vision).toMatchObject({ provider: "vision", input: ["text", "image"] });
});

it("does not make vision available at runtime without its provider credential", () => {
  const configured = createConfiguredModels({
    config: {
      primary: { providerId: "primary", modelId: "text", baseUrl: "https://primary.example/v1" },
      vision: { providerId: "vision", modelId: "image", baseUrl: "https://vision.example/v1" },
    },
    getApiKey: async (providerId) => providerId === "primary" ? "primary-key" : undefined,
  });
  expect(createPrimaryModelRuntime({ workspaceRoot: ".", configured, apiKey: "primary-key" }).visionAvailable).toBe(false);
  expect(createPrimaryModelRuntime({ workspaceRoot: ".", configured, apiKey: "primary-key", visionApiKey: "vision-key" }).visionAvailable).toBe(true);
});
