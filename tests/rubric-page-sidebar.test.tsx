// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RubricPage } from "../web/src/pages/RubricPage.js";

it("can open and close scoring history at narrow widths", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RubricPage)));
    const opener = container.querySelector<HTMLButtonElement>(".rubric-session-toggle");
    expect(opener?.textContent).toBe("展开会话");
    const list = container.querySelector(`#${opener?.getAttribute("aria-controls")}`);
    expect(list?.hasAttribute("inert")).toBe(true);

    await act(async () => opener?.click());
    expect(list?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector(".rubric-workspace")?.classList.contains("sidebar-collapsed")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".rubric-pane-collapse")?.click());
    expect(list?.hasAttribute("inert")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    matchMedia.mockRestore();
    vi.unstubAllGlobals();
  }
});
