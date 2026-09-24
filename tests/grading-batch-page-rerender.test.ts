// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradingBatchPage } from "../web/src/pages/GradingBatchPage.js";

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    json: async () => value,
  } as Response;
}

function batch(id: string, title: string) {
  return {
    id,
    title,
    assignmentId: id === "batch-two" ? "assignment-two" : "assignment-one",
    rubricVersion: 1,
    status: "completed",
    concurrency: 4,
    totalJobs: 0,
    counts: { pending: 0, running: 0, waiting_for_teacher: 0, needs_review: 0, completed: 0, failed: 0, cancelled: 0 },
    jobs: [],
  };
}

describe("batch grading page draft restore rerenders", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    root = undefined;
    container = undefined;
  });

  it("keeps a pending restored draft when rubric, list, and detail fetches rerender the mounted page", async () => {
    const storage = new Map<string, string>([["batch-grading-upload-draft", "draft-restored"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let resolveDraft!: (response: Response) => void;
    const pendingDraftResponse = new Promise<Response>((resolve) => { resolveDraft = resolve; });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/grading/rubrics") {
        return jsonResponse([
          { assignmentId: "assignment-one", title: "评分标准一", version: 1 },
          { assignmentId: "assignment-two", title: "评分标准二", version: 1 },
        ]);
      }
      if (url.startsWith("/api/grading/batches?")) {
        return url.includes("assignment-two")
          ? jsonResponse([batch("batch-two", "批次二")])
          : jsonResponse([batch("batch-one", "批次一")]);
      }
      if (url === "/api/grading/batches/batch-one") return jsonResponse(batch("batch-one", "批次一"));
      if (url === "/api/grading/batches/batch-two") return jsonResponse(batch("batch-two", "批次二"));
      if (url === "/api/grading/batch-uploads/draft-restored") return pendingDraftResponse;
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(GradingBatchPage)));

    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (predicate()) return;
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      }
      throw new Error("Timed out waiting for the page state transition");
    };
    await waitFor(() => calls.includes("/api/grading/batch-uploads/draft-restored"));

    const rubricSelect = container.querySelector<HTMLSelectElement>("[aria-label='批量评分标准']");
    expect(rubricSelect).not.toBeNull();
    await act(async () => {
      rubricSelect!.value = "assignment-two:1";
      rubricSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => calls.includes("/api/grading/batches/batch-two"));
    await waitFor(() => container!.textContent?.includes("批次二") ?? false);
    expect(container.textContent).not.toContain("恢复后的报告.md");

    await act(async () => {
      resolveDraft(jsonResponse({
        id: "draft-restored",
        title: "恢复的班级草稿",
        assignmentId: "assignment-one",
        rubricVersion: 1,
        concurrency: 4,
        status: "draft",
        items: [{ id: "item-one", filename: "恢复后的报告.md", status: "ready" }],
      }));
      await pendingDraftResponse;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("恢复后的报告.md");
    expect(container.textContent).toContain("恢复的班级草稿");
  });

  it("preserves a newly created storage pointer when an older restore request fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const storage = new Map<string, string>([["batch-grading-upload-draft", "draft-old"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
    });
    let rejectOldRestore!: (error: Error) => void;
    const oldRestorePending = new Promise<Response>((_resolve, reject) => { rejectOldRestore = reject; });
    const newDraft = {
      id: "draft-new", title: "新草稿", assignmentId: "assignment-one", rubricVersion: 1,
      concurrency: 4, status: "draft",
      items: [{ id: "item-new", filename: "新报告.md", status: "ready" }],
    };
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/grading/rubrics") return jsonResponse([{ assignmentId: "assignment-one", title: "评分标准", version: 1 }]);
      if (url.startsWith("/api/grading/batches?")) return jsonResponse([]);
      if (url === "/api/grading/batch-uploads/draft-old") return oldRestorePending;
      if (url === "/api/grading/batch-uploads" && init?.method === "POST") {
        return jsonResponse({ ...newDraft, items: [{ ...newDraft.items[0], status: "pending" }] });
      }
      if (url === "/api/grading/batch-uploads/draft-new/items/item-new/file" && init?.method === "PUT") {
        return jsonResponse(newDraft.items[0]);
      }
      if (url === "/api/grading/batch-uploads/draft-new") return jsonResponse(newDraft);
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(GradingBatchPage)));
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (predicate()) return;
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      }
      throw new Error("Timed out waiting for the page state transition");
    };
    await waitFor(() => calls.includes("GET /api/grading/batch-uploads/draft-old"));

    const fileInput = container.querySelector<HTMLInputElement>("input[aria-label='选择学生报告']");
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["synthetic report"], "新报告.md", { type: "text/markdown" })],
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const form = container.querySelector("form.batch-create-card");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => calls.includes("GET /api/grading/batch-uploads/draft-new"));
    expect(storage.get("batch-grading-upload-draft")).toBe("draft-new");

    await act(async () => {
      rejectOldRestore(new Error("draft not found"));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(storage.get("batch-grading-upload-draft")).toBe("draft-new");
  });
});
