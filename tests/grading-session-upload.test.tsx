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
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function openUploadForm(createError?: {
  code: string;
  status: number;
  message?: string;
  issues?: Array<{ path: string; message: string }>;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  window.history.replaceState(null, "", "/grading?rubric=assignment%3A1");
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/courses") return Response.json([]);
    if (url === "/api/grading/rubrics") {
      return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
    }
    if (url.startsWith("/api/grading/sessions?")) return Response.json([]);
    if (url === "/api/grading/sessions" && init?.method === "POST") {
      if (createError) {
        const { status, ...payload } = createError;
        return Response.json(payload, { status });
      }
      return Response.json({
        code: "STUDENT_IDENTITY_FIELDS_REQUIRED",
        issues: [{ path: "studentName", message: "Required" }],
      }, { status: 400 });
    }
    throw new Error(`Unexpected API request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));
  const uploadButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("上传作业"))!;
  await act(async () => uploadButton.click());
  const form = container.querySelector<HTMLFormElement>(".grading-new-dialog")!;
  const reportInput = form.querySelector<HTMLInputElement>("input[name='file']")!;
  const submit = async () => {
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  };
  const chooseReport = async (report: File) => {
    const selection = new DataTransfer();
    selection.items.add(report);
    reportInput.files = selection.files;
    await act(async () => reportInput.dispatchEvent(new Event("change", { bubbles: true })));
  };
  return { form, reportInput, submit, chooseReport, fetchMock };
}

it("clears the missing report notice and field marker as soon as a nonempty report is selected", async () => {
  const { form, reportInput, submit, chooseReport, fetchMock } = await openUploadForm();
  await submit();
  expect(form.querySelector(".modal-error")?.textContent).toBe("请先选择学生报告文件");
  expect(reportInput.getAttribute("aria-invalid")).toBe("true");

  await chooseReport(new File([], "空报告.md"));
  expect(form.querySelector(".modal-error")?.textContent).toBe("请先选择学生报告文件");

  await chooseReport(new File(["# 模拟报告"], "模拟报告.md"));
  expect(form.querySelector(".modal-error")).toBeNull();
  expect(reportInput.getAttribute("aria-invalid")).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("keeps an unrelated submission error and field marker when a report is replaced", async () => {
  const { form, submit, chooseReport, fetchMock } = await openUploadForm();
  await chooseReport(new File(["# 模拟报告"], "模拟报告.md"));
  await submit();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  const error = form.querySelector(".modal-error")?.textContent;
  expect(error).toBeTruthy();

  await chooseReport(new File(["# 第二份报告"], "第二份报告.md"));
  expect(form.querySelector(".modal-error")?.textContent).toBe(error);
  expect(form.querySelector("input[name='studentName']")?.getAttribute("aria-invalid")).toBe("true");
});

it.each(["pdf", "docx"])("offers the create action when a %s upload is blocked before session creation", async (extension) => {
  const { form, reportInput, submit, chooseReport } = await openUploadForm({ code: "CONVERTER_NOT_CONFIGURED", status: 503 });
  const filename = `模拟报告.${extension}`;
  await chooseReport(new File(["synthetic nonempty report"], filename));
  await submit();

  const message = form.querySelector(".modal-error")?.textContent;
  expect(message).toContain("转换服务");
  expect(message).toContain("创建会话");
  expect(message).toContain("Markdown");
  expect(message).not.toContain("重试转换");
  const createButton = form.querySelector<HTMLButtonElement>("button[type='submit']");
  expect(createButton?.textContent).toBe("创建会话");
  expect(createButton?.disabled).toBe(false);
  expect(reportInput.files?.[0]?.name).toBe(filename);
});

it("guides a missing Markdown image to the folder picker without copying server details", async () => {
  const serverDetail = "C:\\server\\workspace\\internal\\trend.png";
  const { form, reportInput, submit, chooseReport } = await openUploadForm({
    code: "SUBMISSION_ASSET_MISSING",
    status: 422,
    message: serverDetail,
    issues: [{ path: "assets/figures/trend.png", message: serverDetail }],
  });
  await chooseReport(new File(["![趋势图](assets/figures/trend.png)"], "模拟报告.md"));
  await submit();

  const message = form.querySelector(".modal-error")?.textContent;
  expect(message).toContain("Markdown 图片目录（可选）");
  expect(message).toContain("assets 目录");
  expect(message).toContain("创建会话");
  expect(message).not.toContain(serverDetail);
  expect(message).not.toContain("重启");
  expect(form.querySelector("input[name='assetDirectory']")?.getAttribute("aria-invalid")).toBe("true");
  expect(reportInput.files?.[0]?.name).toBe("模拟报告.md");
});

it.each(["txt", "TXT"])("guides a .%s report with image references to an actionable report change", async (extension) => {
  const { form, reportInput, submit, chooseReport } = await openUploadForm({ code: "SUBMISSION_ASSET_MISSING", status: 422 });
  await chooseReport(new File(["![趋势图](assets/figures/trend.png)"], `模拟报告.${extension}`));
  await submit();

  const message = form.querySelector(".modal-error")?.textContent;
  expect(message).toContain("另存为 .md");
  expect(message).toContain("移除图片引用");
  expect(message).not.toContain("Markdown 图片目录（可选）");
  expect(reportInput.getAttribute("aria-invalid")).toBe("true");
  expect(form.querySelector("input[name='assetDirectory']")?.getAttribute("aria-invalid")).toBeNull();
});
