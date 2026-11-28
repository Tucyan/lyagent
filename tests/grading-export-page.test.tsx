// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradingExportPage } from "../web/src/pages/GradingExportPage.js";

function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  } as Response;
}

describe("GradingExportPage", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    root = undefined;
    container = undefined;
  });

  function setupDom(url: string, options: {
    batches?: unknown[];
    rubrics?: unknown[];
    students?: unknown[];
    onPreview?: (body: any, callIndex: number) => Promise<Response> | Response;
  } = {}) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
    window.history.replaceState(null, "", url);

    const batches = options.batches ?? [
      {
        id: "batch-confirmed",
        courseId: "course-1",
        title: "一班正式批改",
        assignmentId: "a1",
        rubricVersion: 1,
        status: "completed",
        concurrency: 4,
        totalJobs: 2,
        counts: { pending: 0, running: 0, waiting_for_teacher: 0, needs_review: 0, completed: 2, failed: 0, cancelled: 0 },
      },
      {
        id: "batch-review",
        courseId: "course-1",
        title: "二班待复核批改",
        assignmentId: "a1",
        rubricVersion: 1,
        status: "completed",
        concurrency: 4,
        totalJobs: 2,
        counts: { pending: 0, running: 0, waiting_for_teacher: 0, needs_review: 2, completed: 0, failed: 0, cancelled: 0 },
      },
    ];
    const rubrics = options.rubrics ?? [
      { assignmentId: "a1", courseId: "course-1", title: "实验一评分标准", version: 1 },
    ];
    const students = options.students ?? [
      { studentNumber: "20260001", studentName: "张晓明", confirmedCount: 2, totalCount: 2 },
      { studentNumber: "20260002", studentName: "李华", confirmedCount: 1, totalCount: 1 },
    ];

    let previewCall = 0;
    const previewPayloads: any[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl === "/api/courses") return jsonResponse([{ id: "course-1", name: "数据结构" }]);
      if (requestUrl === "/api/grading/batches?courseId=course-1") return jsonResponse(batches);
      if (requestUrl === "/api/grading/rubrics?courseId=course-1") return jsonResponse(rubrics);
      if (requestUrl === "/api/grading/exports/students?courseId=course-1") return jsonResponse(students);
      if (requestUrl === "/api/grading/exports/preview") {
        previewCall += 1;
        const body = JSON.parse(String(init?.body ?? "{}"));
        previewPayloads.push(body);
        if (options.onPreview) return options.onPreview(body, previewCall);
        const rows = body.scope.kind === "batch" && body.scope.includeUnconfirmed
          ? [
              {
                sessionId: "s1",
                studentName: "张晓明",
                studentNumber: "20260001",
                submissionTitle: "报告1",
                reviewStatus: "confirmed",
                earnedScore: 90,
                possibleScore: 100,
                overallConfidence: 0.94,
                cells: ["张晓明", "20260001", "报告1", 90, 0.94],
              },
              {
                sessionId: "s2",
                studentName: "李华",
                studentNumber: "20260002",
                submissionTitle: "报告2",
                reviewStatus: "needs_review",
                earnedScore: 70,
                possibleScore: 100,
                overallConfidence: 0.72,
                cells: ["李华", "20260002", "报告2", 70, 0.72],
              },
            ]
          : [
              {
                sessionId: "s1",
                studentName: "张晓明",
                studentNumber: "20260001",
                submissionTitle: "报告1",
                reviewStatus: "confirmed",
                earnedScore: 90,
                possibleScore: 100,
                overallConfidence: 0.94,
                cells: ["张晓明", "20260001", "报告1", 90, 0.94],
              },
            ];
        return jsonResponse({
          headers: ["学生姓名", "学号", "作业名称", "总分", "总置信度"],
          rows,
          summary: {
            totalCount: rows.length,
            uniqueStudentCount: rows.length,
            confirmedCount: rows.filter((r) => r.reviewStatus === "confirmed").length,
            needsReviewCount: rows.filter((r) => r.reviewStatus === "needs_review").length,
            averageScore: rows.length === 2 ? 80 : 90,
            highestScore: 90,
            lowestScore: rows.length === 2 ? 70 : 90,
          },
          csvText: "\uFEFF学生姓名,学号,作业名称,总分,总置信度\r\n张晓明,20260001,报告1,90,0.94\r\n",
        });
      }
      throw new Error(`Unexpected API request: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    return { fetchMock, previewPayloads };
  }

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("omits quick-return links on direct sidebar entry and supports stats, filtering, and scope switching", async () => {
    const { previewPayloads } = setupDom("/grading/exports?course=course-1");
    await act(async () => root!.render(createElement(GradingExportPage)));
    await flush();

    expect(container!.textContent).not.toContain("返回单份批改");
    expect(container!.textContent).not.toContain("返回批量批改");
    expect(container!.querySelector(".export-stats-bar")?.textContent).toContain("90");

    const studentTab = Array.from(container!.querySelectorAll(".export-scope-tab"))
      .find((el) => el.textContent?.includes("按学生"));
    expect(studentTab).toBeDefined();
    await act(async () => {
      (studentTab as HTMLButtonElement).click();
    });
    await flush();
    expect(previewPayloads.some((p) => p.scope.kind === "student" && p.scope.studentNumber === "20260001")).toBe(true);

    const studentSearch = container!.querySelector<HTMLInputElement>("input[aria-label='检索学生']");
    expect(studentSearch).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(studentSearch!, "李华");
      studentSearch!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const studentSelect = container!.querySelector<HTMLSelectElement>("select[aria-label='选择导出学生']");
    expect(Array.from(studentSelect!.options).map((o) => o.value)).toEqual(["20260002"]);
    expect(previewPayloads.at(-1)?.scope).toEqual({
      kind: "student",
      courseId: "course-1",
      studentNumber: "20260002",
    });
  });

  it("shows ONLY quick return to single grading when entered from single grading", async () => {
    setupDom("/grading/exports?from=grading&course=course-1&rubric=a1%3A1&session=s1&student=20260001");
    await act(async () => root!.render(createElement(GradingExportPage)));
    await flush();

    const returnLink = container!.querySelector<HTMLAnchorElement>(".export-page-header a");
    expect(returnLink?.textContent).toBe("返回单份批改");
    expect(returnLink?.getAttribute("href")).toBe("/grading?session=s1&course=course-1");
    expect(container!.textContent).not.toContain("返回批量批改");
  });

  it("defaults all table rows selected, updates stats and downloaded CSV when rows are unchecked, and supports header select-all toggle", async () => {
    const { previewPayloads } = setupDom("/grading/exports?from=batch&scope=batch&batch=batch-review&rubric=a1%3A1&course=course-1");
    let capturedBlobText = "";
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const origBlob = globalThis.Blob;
    class MockBlob {
      constructor(parts: BlobPart[]) {
        capturedBlobText = parts.map((p) => String(p)).join("");
      }
    }
    vi.stubGlobal("Blob", MockBlob as unknown as typeof Blob);
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();

    try {
      await act(async () => root!.render(createElement(GradingExportPage)));
      await flush();

      expect(previewPayloads.at(-1)?.columns.rubricName).toBe(true);
      const returnLink = container!.querySelector<HTMLAnchorElement>(".export-page-header a");
      expect(returnLink?.textContent).toBe("返回批量批改");
      expect(returnLink?.getAttribute("href")).toBe("/grading/batches?batch=batch-review&rubric=a1%3A1&course=course-1");
      expect(container!.textContent).not.toContain("返回单份批改");

      expect(previewPayloads.at(-1)?.scope).toEqual({
        kind: "batch",
        batchId: "batch-review",
        includeUnconfirmed: true,
      });
      // Inline needs_review badge appears on pending row even when reviewStatus column isn't selected
      expect(container!.querySelectorAll(".export-row-review-tag")).toHaveLength(1);
      expect(container!.querySelector("tr.is-needs-review")?.textContent).toContain("李华");

      const selectAllBox = container!.querySelector<HTMLInputElement>("thead input[aria-label='全选或取消全选当前记录']");
      const rowCheckboxes = Array.from(container!.querySelectorAll<HTMLInputElement>("tbody .export-select-col input[type='checkbox']"));
      expect(selectAllBox?.checked).toBe(true);
      expect(rowCheckboxes).toHaveLength(2);
      expect(rowCheckboxes.every((box) => box.checked)).toBe(true);
      expect(container!.querySelector(".export-stats-bar")?.textContent).toContain("80");
      expect(container!.querySelector(".export-stats-bar")?.textContent).toContain("90 / 70");

      // Uncheck first student (张晓明, 90分), leaving 李华 (70分)
      await act(async () => {
        rowCheckboxes[0]!.click();
      });
      await flush();
      expect(selectAllBox?.checked).toBe(false);
      expect(selectAllBox?.indeterminate).toBe(true);
      expect(container!.querySelector(".export-stats-bar")?.textContent).toContain("1 人");
      expect(container!.querySelector(".export-stats-bar")?.textContent).toContain("70");
      const downloadBtn = Array.from(container!.querySelectorAll("button"))
        .find((btn) => btn.textContent?.includes("确认下载 CSV")) as HTMLButtonElement;
      expect(downloadBtn.textContent).toContain("1 条");
      expect(downloadBtn.disabled).toBe(false);

      await act(async () => {
        downloadBtn.click();
      });
      expect(capturedBlobText).toContain("李华");
      expect(capturedBlobText).not.toContain("张晓明");

      // Click select-all twice: first selects all, second deselects all and disables download
      await act(async () => {
        selectAllBox!.click();
      });
      await flush();
      expect(selectAllBox?.checked).toBe(true);
      expect(downloadBtn.textContent).toContain("2 条");

      await act(async () => {
        selectAllBox!.click();
      });
      await flush();
      expect(selectAllBox?.checked).toBe(false);
      expect(downloadBtn.textContent).toContain("0 条");
      expect(downloadBtn.disabled).toBe(true);

      // Re-select all and test keyword filtering recalculating stats
      await act(async () => {
        selectAllBox!.click();
      });
      await flush();
      const searchInput = container!.querySelector<HTMLInputElement>("input[aria-label='关键词筛选']");
      expect(searchInput).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(searchInput!, "李华");
        searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush();
      expect(container!.querySelector(".export-stats-bar")?.textContent).toContain("70");
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      vi.stubGlobal("Blob", origBlob);
    }
  });

  it("displays column settings directly expanded in preview top panel, handles stale responses, and prevents empty-column exports", async () => {
    let resolveSlow!: (res: Response) => void;
    let callCount = 0;
    setupDom("/grading/exports?course=course-1", {
      onPreview: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveSlow = resolve;
          });
        }
        return jsonResponse({
          headers: ["学生姓名", "总分"],
          rows: [
            {
              sessionId: "fast-row",
              studentName: "最新学生",
              studentNumber: "20269999",
              submissionTitle: "最新报告",
              reviewStatus: "confirmed",
              earnedScore: 95,
              possibleScore: 100,
              overallConfidence: 0.99,
              cells: ["最新学生", 95],
            },
          ],
          csvText: "\uFEFF学生姓名,总分\r\n最新学生,95\r\n",
        });
      },
    });
    await act(async () => root!.render(createElement(GradingExportPage)));
    await flush();

    // Column settings must be directly expanded in the top preview panel, not inside aside.export-config-pane or popover
    expect(container!.querySelector(".export-config-pane")?.textContent).not.toContain("导出列设置");
    expect(container!.querySelector(".export-page-header .export-column-trigger")).toBeNull();
    const inlinePanel = container!.querySelector(".export-preview-pane .export-column-inline-panel");
    expect(inlinePanel).not.toBeNull();
    expect(inlinePanel!.textContent).toContain("评分标准");

    // Trigger a newer request (summary preset) while first request is still pending
    const summaryPresetBtn = Array.from(container!.querySelectorAll(".export-presets-row button"))
      .find((btn) => btn.textContent === "仅成绩汇总") as HTMLButtonElement;
    await act(async () => {
      summaryPresetBtn.click();
    });
    await flush();
    expect(container!.textContent).toContain("最新学生");

    // Resolve older slow request: it must NOT overwrite newer "最新学生" result
    await act(async () => {
      resolveSlow(jsonResponse({
        headers: ["学生姓名"],
        rows: [
          {
            sessionId: "stale-row",
            studentName: "过期旧学生",
            studentNumber: "20260000",
            submissionTitle: "旧报告",
            reviewStatus: "confirmed",
            earnedScore: 10,
            possibleScore: 100,
            overallConfidence: 0.5,
            cells: ["过期旧学生"],
          },
        ],
        csvText: "\uFEFF学生姓名\r\n过期旧学生\r\n",
      }));
      await Promise.resolve();
    });
    await flush();
    expect(container!.textContent).toContain("最新学生");
    expect(container!.textContent).not.toContain("过期旧学生");

    // Uncheck all remaining checked columns inside the top-bar popover
    const checkboxes = Array.from(container!.querySelectorAll<HTMLInputElement>(".export-column-chips input[type='checkbox']"));
    for (const checkbox of checkboxes) {
      if (checkbox.checked && !checkbox.disabled) {
        await act(async () => {
          checkbox.click();
        });
      }
    }
    await flush();
    expect(container!.textContent).toContain("请至少选择 1 列导出字段");
    const downloadBtn = Array.from(container!.querySelectorAll("button"))
      .find((btn) => btn.textContent?.includes("确认下载 CSV")) as HTMLButtonElement;
    expect(downloadBtn.disabled).toBe(true);
  });

  it("auto-switches multi-rubric students to compact score-rate summary with expand toggle and prefers non-empty rubric by default", async () => {
    const { previewPayloads } = setupDom("/grading/exports?course=course-1", {
      rubrics: [
        { assignmentId: "a1", courseId: "course-1", title: "实验一评分标准", version: 2, sessionCount: 0, confirmedCount: 0 },
        { assignmentId: "a1", courseId: "course-1", title: "实验一评分标准", version: 1, sessionCount: 10, confirmedCount: 10 },
      ],
      students: [
        { studentNumber: "20260001", studentName: "张晓明", confirmedCount: 2, totalCount: 2, rubricCount: 2 },
      ],
      onPreview: (body) => {
        if (body.scope.kind === "student") {
          return jsonResponse({
            headers: ["学生姓名", "学号", "作业名称", "评分标准", "总分", "满分", "得分率", "总置信度"],
            rows: [
              {
                sessionId: "m1",
                rubricKey: "a1:1",
                rubricTitle: "实验一评分标准 v1",
                studentName: "张晓明",
                studentNumber: "20260001",
                submissionTitle: "实验一",
                reviewStatus: "confirmed",
                earnedScore: 19,
                possibleScore: 20,
                overallConfidence: 0.96,
                cells: ["张晓明", "20260001", "实验一", "实验一评分标准 v1", 19, 20, "95.0%", 0.96],
              },
              {
                sessionId: "m2",
                rubricKey: "a2:1",
                rubricTitle: "实验二评分标准 v1",
                studentName: "张晓明",
                studentNumber: "20260001",
                submissionTitle: "实验二",
                reviewStatus: "confirmed",
                earnedScore: 75,
                possibleScore: 100,
                overallConfidence: 0.91,
                cells: ["张晓明", "20260001", "实验二", "实验二评分标准 v1", 75, 100, "75.0%", 0.91],
              },
            ],
            csvText: "\uFEFF学生姓名\r\n",
          });
        }
        return jsonResponse({
          headers: ["学生姓名", "总分"],
          rows: [],
          csvText: "\uFEFF学生姓名,总分\r\n",
        });
      },
    });
    await act(async () => root!.render(createElement(GradingExportPage)));
    await flush();

    // Default rubric skipped empty v2 (0) and picked v1 (10)
    expect(previewPayloads[0]?.scope).toEqual({
      kind: "rubric",
      assignmentId: "a1",
      rubricVersion: 1,
    });

    const studentTab = Array.from(container!.querySelectorAll(".export-scope-tab"))
      .find((el) => el.textContent?.includes("按学生")) as HTMLButtonElement;
    await act(async () => {
      studentTab.click();
    });
    await flush();

    // Multi-rubric student automatically dropped itemDetails and enabled possibleScore + scoreRate
    expect(previewPayloads.at(-1)?.columns).toMatchObject({
      itemDetails: false,
      possibleScore: true,
      scoreRate: true,
    });
    const statsText = container!.querySelector(".export-stats-bar")?.textContent ?? "";
    expect(statsText).toContain("平均得分率");
    expect(statsText).toContain("85%");
    expect(statsText).toContain("95% / 75%");

    const expandBtn = Array.from(container!.querySelectorAll("button"))
      .find((btn) => btn.textContent?.includes("展开全部明细列")) as HTMLButtonElement;
    expect(expandBtn).toBeDefined();
    await act(async () => {
      expandBtn.click();
    });
    await flush();
    expect(previewPayloads.at(-1)?.columns.itemDetails).toBe(true);
  });

  it("positions searchable picker popover in viewport coordinates without expanding export config pane", async () => {
    setupDom("/grading/exports?course=course-1", {
      rubrics: [
        { assignmentId: "a1", courseId: "course-1", title: "实验一：超长评分标准标题测试", version: 1, sessionCount: 5, confirmedCount: 5 },
        { assignmentId: "a2", courseId: "course-1", title: "实验二：时序预测", version: 1, sessionCount: 5, confirmedCount: 4 },
      ],
    });
    await act(async () => root!.render(createElement(GradingExportPage)));
    await flush();

    const trigger = container!.querySelector<HTMLButtonElement>(".searchable-picker-trigger")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 80,
      y: 620,
      top: 620,
      left: 80,
      bottom: 654,
      right: 344,
      width: 264,
      height: 34,
      toJSON: () => ({}),
    });

    await act(async () => {
      trigger.click();
    });
    await flush();

    const popover = container!.querySelector<HTMLDivElement>(".searchable-picker-popover")!;
    expect(popover).not.toBeNull();
    // Near bottom (654 / 768 window height), popover flips upward via fixed bottom coordinate
    expect(popover.style.bottom).toBeTruthy();

    const [fs, nodePath] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const cssSource = await fs.readFile(
      nodePath.resolve("web", "src", "styles", "ux-polish.css"),
      "utf8",
    );
    expect(cssSource).toMatch(/\.searchable-picker-popover\s*\{[^}]*position:\s*fixed/s);
    expect(cssSource).toMatch(/\.export-config-pane\s*\{[^}]*overflow-x:\s*hidden/s);
  });
});
