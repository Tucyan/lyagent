// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

vi.mock("../web/src/pages/KnowledgeLibraryPage", () => ({ KnowledgeLibraryPage: () => null }));
vi.mock("../web/src/pages/RubricPage", () => ({ RubricPage: () => null }));
vi.mock("../web/src/pages/ModelSettingsPage", () => ({ ModelSettingsPage: () => null }));

it.each([
  { entry: "/knowledge", destinations: ["/rubrics", "/settings/models", "/knowledge"], compact: false },
  { entry: "/rubrics", destinations: ["/knowledge", "/settings/models", "/rubrics"], compact: true },
])("keeps the initial sidebar state when navigating from $entry with no saved preference", async ({ entry, destinations, compact }) => {
  const previousUrl = window.location.href;
  window.history.replaceState(null, "", entry);
  const savePreference = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: savePreference });
  vi.stubGlobal("fetch", async (url: string) => Response.json(
    url === "/api/system/models" ? { primary: { configured: true } } : [],
  ));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(App)));
    const readCompact = () => container.querySelector(".admin-shell")!.classList.contains("nav-compact");
    const states = [readCompact()];
    for (const destination of destinations) {
      const icon = container.querySelector('.admin-nav a[href="' + destination + '"] svg path')!;
      await act(async () => {
        icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(window.location.pathname).toBe(destination);
      expect(container.querySelector(".admin-nav a[aria-current='page']")?.getAttribute("href")).toBe(destination);
      states.push(readCompact());
    }
    expect(states).toEqual([compact, compact, compact, compact]);
    expect(savePreference).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    window.history.replaceState(null, "", previousUrl);
    container.remove();
    vi.unstubAllGlobals();
  }
});
