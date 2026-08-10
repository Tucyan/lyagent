import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildModelSettingsPayload,
  modelConfigurationFailureMessage,
  modelConfigurationFailureReason,
  modelSettingsRequest,
  modelSettingsStateFromStatus,
  resolveAppRoute,
} from "../web/src/pages/model-settings-page-model.js";

const status = {
  primary: { providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", configured: false },
};

describe("model settings page model", () => {
  it("redirects normal pages to setup until the primary model is configured", () => {
    expect(resolveAppRoute("/grading", false)).toEqual({ kind: "redirect", href: "/setup" });
    expect(resolveAppRoute("/setup", false)).toEqual({ kind: "setup" });
    expect(resolveAppRoute("/settings/models", true)).toEqual({ kind: "settings" });
    expect(resolveAppRoute("/grading", true)).toEqual({ kind: "app", path: "/grading" });
  });

  it("never hydrates API keys and reuses primary credentials unless vision overrides them", () => {
    const initial = modelSettingsStateFromStatus(status);
    expect(initial.primary.apiKey).toBe("");
    const reused = buildModelSettingsPayload({
      ...initial,
      primary: { ...initial.primary, apiKey: "primary-secret" },
      visionEnabled: true,
      visionModelId: "vision-model",
    });
    expect(reused).toEqual({
      primary: { providerId: "openai", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", apiKey: "primary-secret" },
      vision: { providerId: "openai", modelId: "vision-model", baseUrl: "https://api.deepseek.com" },
    });

    const customEndpoint = buildModelSettingsPayload({
      ...initial,
      primary: { ...initial.primary, providerId: "qwen-openai", modelId: "qwen3.7-flash", baseUrl: "https://models.example/v1", apiKey: "primary-secret" },
      visionEnabled: true,
      visionModelId: "qwen3.7-flash",
    });
    expect(customEndpoint.primary.providerId).toBe("qwen-openai");
    expect(customEndpoint.vision?.providerId).toBe("qwen-openai");

    const independent = buildModelSettingsPayload({
      ...initial,
      primary: { ...initial.primary, apiKey: "primary-secret" },
      visionEnabled: true,
      visionModelId: "vision-model",
      visionUsesPrimaryCredentials: false,
      visionProviderId: "vision-provider",
      visionBaseUrl: "https://vision.example/v1",
      visionApiKey: "vision-secret",
    });
    expect(independent.vision).toEqual({ providerId: "vision-provider", modelId: "vision-model", baseUrl: "https://vision.example/v1", apiKey: "vision-secret" });

    const independentFromShared = buildModelSettingsPayload({
      ...initial,
      primary: { ...initial.primary, apiKey: "primary-secret" },
      visionEnabled: true,
      visionModelId: "vision-model",
      visionUsesPrimaryCredentials: false,
      visionProviderId: initial.primary.providerId,
      visionBaseUrl: "https://vision.example/v1",
      visionApiKey: "vision-secret",
    });
    expect(independentFromShared.vision?.providerId).not.toBe(independentFromShared.primary.providerId);
  });

  it("normalizes legacy compatible providers and preserves an explicit OpenAI provider for proxy URLs", () => {
    const qwen = modelSettingsStateFromStatus({
      primary: { providerId: "custom", modelId: "qwen3.7-flash", baseUrl: "https://example.cn/compatible-mode/v1", configured: true },
    });
    expect(qwen.primary.providerId).toBe("qwen-openai");

    const openai = buildModelSettingsPayload({
      ...qwen,
      primary: { ...qwen.primary, providerId: "openai", modelId: "gpt-5.6-luna", baseUrl: "https://botcf.com/v1", apiKey: "temporary" },
    });
    expect(openai.primary.providerId).toBe("openai");
    expect(openai.primary.baseUrl).toBe("https://botcf.com/v1");
  });

  it("uses the bootstrap CSRF token for test and save writes", () => {
    for (const method of ["POST", "PUT"] as const) {
      const request = modelSettingsRequest(method, "csrf-bootstrap", { primary: { providerId: "p", modelId: "m", baseUrl: "https://example.test", apiKey: "secret" } });
      expect(new Headers(request.headers).get("x-csrf-token")).toBe("csrf-bootstrap");
      expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    }
  });

  it("turns safe provider reasons into actionable setup messages", () => {
    expect(modelConfigurationFailureMessage("model_not_found")).toContain("模型 ID");
    expect(modelConfigurationFailureMessage("tool_call_missing")).toContain("工具调用");
    expect(modelConfigurationFailureMessage("authentication_failed")).toContain("API Key");
    expect(modelConfigurationFailureMessage(undefined)).toContain("模型连接或保存失败");
  });

  it("reads only the safe failure reason from a rejected setup response", async () => {
    const response = new Response(JSON.stringify({ reason: "model_not_found", detail: "private provider body" }), { status: 422 });
    expect(await modelConfigurationFailureReason(response)).toBe("model_not_found");
    expect(await modelConfigurationFailureReason(new Response("not-json", { status: 422 }))).toBeUndefined();
  });
});

it("presents Docling converter status and attribution without legacy MinerU wording", async () => {
  const source = await readFile(path.resolve("web", "src", "pages", "ModelSettingsPage.tsx"), "utf8");
  expect(source).toMatch(/Docling/);
  expect(source).not.toMatch(/MinerU|mineru|backend/);
  expect(source).toMatch(/Qwen（Chat Completions）/);
  expect(source).toMatch(/OpenAI（按 URL 自动识别）/);
});
