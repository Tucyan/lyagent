import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildModelSettingsPayload,
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
      primary: { providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", apiKey: "primary-secret" },
      vision: { providerId: "deepseek", modelId: "vision-model", baseUrl: "https://api.deepseek.com" },
    });

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

  it("uses the bootstrap CSRF token for test and save writes", () => {
    for (const method of ["POST", "PUT"] as const) {
      const request = modelSettingsRequest(method, "csrf-bootstrap", { primary: { providerId: "p", modelId: "m", baseUrl: "https://example.test", apiKey: "secret" } });
      expect(new Headers(request.headers).get("x-csrf-token")).toBe("csrf-bootstrap");
      expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    }
  });
});

it("presents Docling converter status and attribution without legacy MinerU wording", async () => {
  const source = await readFile(path.resolve("web", "src", "pages", "ModelSettingsPage.tsx"), "utf8");
  expect(source).toMatch(/Docling/);
  expect(source).not.toMatch(/MinerU|mineru|backend/);
});
