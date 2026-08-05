import { expect, it, vi } from "vitest";
import { waitForRestartHealth } from "../web/src/pages/model-settings-page-model.js";

it("polls health until the restarted app becomes ready", async () => {
  const health = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await expect(waitForRestartHealth({ health, sleep: async () => undefined, maxAttempts: 4 })).resolves.toBe(true);
  expect(health).toHaveBeenCalledTimes(3);
});
