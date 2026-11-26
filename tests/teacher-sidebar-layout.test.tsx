// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AdminShell } from "../web/src/components/AdminShell.js";

it("keeps the desktop teacher sidebar and long course names within the narrow expanded layout", async () => {
  const courseName = "Python程序设计基础：面向对象编程、数据分析与综合项目实践";
  const style = document.createElement("style");
  for (const file of ["tokens.css", "ux-polish.css"]) {
    style.append(readFileSync(new URL("../web/src/styles/" + file, import.meta.url), "utf8"));
  }
  document.head.append(style);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("fetch", async () => Response.json([{ id: "course-1", name: courseName }]));

  try {
    await act(async () => root.render(createElement(AdminShell, { active: "dashboard", children: null })));

    const shell = container.querySelector<HTMLElement>(".admin-shell")!;
    const select = container.querySelector<HTMLSelectElement>(".admin-course-switcher select")!;
    expect(getComputedStyle(shell).getPropertyValue("--nav-width-expanded").trim()).toBe("184px");
    expect(getComputedStyle(select.parentElement!).gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(getComputedStyle(select).textOverflow).toBe("ellipsis");
    expect(select.selectedOptions[0]?.textContent).toBe(courseName);
    expect(select.title).toBe(courseName);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    container.remove();
    style.remove();
  }
});
