// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GradingPage } from "../web/src/pages/GradingPage.js";

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function session(id: string, conversionStatus: string) {
  return {
    id, title: `模拟会话 ${id}`, assignmentId: "assignment", rubricVersion: 1,
    studentName: id, studentNumber: id, conversionStatus, gradingStatus: "not_started",
    conversionAttemptCount: conversionStatus === "queued" ? 0 : 1,
    submissionTitleStatus: conversionStatus === "ready" ? "resolved" : "pending",
  };
}

async function mount(search: string, fetchResponse: (url: string) => Promise<Response>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  window.history.replaceState(null, "", `/grading${search}`);
  const fetchMock = vi.fn((input: RequestInfo | URL) => fetchResponse(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));
  return fetchMock;
}

function detail(status: string) {
  return {
    ...session("primary", status),
    submission: status === "ready" ? { markdown: "# 转换后的模拟作业", locked: false } : null,
    rubric: {}, draft: null, confirmed: null, conversation: { messages: [] },
  };
}

function workflow(id: string) {
  return container.querySelector(`a[href='/grading?session=${id}'] .grading-workflow-tag`)?.textContent;
}

it("keeps the selected card consistent with the preview when the list sees conversion changes first", async () => {
  let detailStatus = "queued";
  let listStatus = "running";
  const fetchMock = await mount("?session=primary", async (url) => {
    if (url === "/api/courses") return Response.json([]);
    if (url === "/api/grading/rubrics") {
      return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
    }
    if (url.startsWith("/api/grading/sessions?")) {
      return Response.json([session("primary", listStatus), session("other", "running")]);
    }
    if (url === "/api/grading/sessions/primary") return Response.json(detail(detailStatus));
    throw new Error(`Unexpected API request: ${url}`);
  });

  const previewTitle = () => container.querySelector(".conversion-state h3")?.textContent;
  expect(previewTitle()).toBe("等待开始转换");
  expect(workflow("primary")).toBe("排队转换 · 未开始批改");
  expect(workflow("other")).toBe("正在转换 · 未开始批改");

  detailStatus = "running";
  listStatus = "ready";
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(previewTitle()).toBe("正在转换作业");
  expect(workflow("primary")).toBe("正在转换 · 未开始批改");
  expect(container.querySelector(".submission-document")).toBeNull();

  detailStatus = "ready";
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(workflow("primary")).toBe("转换完成 · 未开始批改");
  expect(container.querySelector(".submission-document")?.textContent).toContain("转换后的模拟作业");
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/grading/sessions?"))).toHaveLength(3);
});

it("refreshes an unselected conversion without reloading the ready detail or the upload form and stops after completion", async () => {
  let otherStatus = "queued";
  const fetchMock = await mount("?session=primary", async (url) => {
    if (url === "/api/courses") return Response.json([]);
    if (url === "/api/grading/rubrics") {
      return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
    }
    if (url.startsWith("/api/grading/sessions?")) return Response.json([session("primary", "ready"), session("other", otherStatus)]);
    if (url === "/api/grading/sessions/primary") return Response.json(detail("ready"));
    throw new Error(`Unexpected API request: ${url}`);
  });
  const count = (url: string) => fetchMock.mock.calls.filter(([request]) => String(request).startsWith(url)).length;
  const upload = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("上传作业"))!;
  await act(async () => upload.click());
  const studentName = container.querySelector<HTMLInputElement>(".grading-new-dialog input[name='studentName']")!;
  studentName.value = "待录入学生";
  expect(workflow("other")).toBe("排队转换 · 未开始批改");

  otherStatus = "running";
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(workflow("other")).toBe("正在转换 · 未开始批改");
  expect(count("/api/grading/sessions?")).toBe(2);

  otherStatus = "ready";
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(workflow("other")).toBe("转换完成 · 未开始批改");
  expect(count("/api/grading/sessions?")).toBe(3);
  expect(studentName.isConnected).toBe(true);
  expect(studentName.value).toBe("待录入学生");

  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(count("/api/grading/sessions?")).toBe(3);
  expect(count("/api/grading/sessions/primary")).toBe(1);
});

it("ignores an old list response after switching courses and frozen rubrics", async () => {
  const availableCourses = [{ id: "course-one" }, { id: "course-two" }];
  let resolveOldList!: (response: Response) => void;
  const oldListPending = new Promise<Response>((resolve) => { resolveOldList = resolve; });
  let resolveNewCourse!: (response: Response) => void;
  const newCoursePending = new Promise<Response>((resolve) => { resolveNewCourse = resolve; });
  let oldListCalls = 0;
  const fetchMock = await mount("?course=course-one&session=primary", async (url) => {
    if (url === "/api/courses") return window.location.search.includes("course-two") ? newCoursePending : Response.json(availableCourses);
    if (url === "/api/grading/rubrics?courseId=course-one") {
      return Response.json([{ assignmentId: "assignment", title: "旧评分表", version: 1 }]);
    }
    if (url === "/api/grading/rubrics?courseId=course-two") {
      return Response.json([{ assignmentId: "other-assignment", title: "新评分表", version: 2 }]);
    }
    if (url === "/api/grading/sessions?assignmentId=assignment&rubricVersion=1") {
      oldListCalls += 1;
      if (oldListCalls > 1) return oldListPending;
      return Response.json([session("primary", "ready"), session("other", "running")]);
    }
    if (url === "/api/grading/sessions?assignmentId=other-assignment&rubricVersion=2") return Response.json([session("new", "ready")]);
    if (url === "/api/grading/sessions/primary") return Response.json({ ...detail("ready"), courseId: "course-one" });
    throw new Error(`Unexpected API request: ${url}`);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(oldListCalls).toBe(2);

  await act(async () => {
    window.history.pushState(null, "", "/grading?course=course-two&rubric=other-assignment%3A2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => resolveOldList(Response.json([session("stale", "ready")])));
  expect(workflow("stale")).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(oldListCalls).toBe(2);

  await act(async () => resolveNewCourse(Response.json(availableCourses)));
  expect(workflow("new")).toBe("转换完成 · 未开始批改");
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("assignmentId=other-assignment"))).toHaveLength(1);
});
