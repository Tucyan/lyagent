import { describe, expect, it } from "vitest";
import * as qaPage from "../web/src/pages/course-qa-page-model.js";

describe("course QA page availability", () => {
  it("distinguishes an unselected course from a selected course without published knowledge", () => {
    const resolve = (qaPage as typeof qaPage & {
      courseQaComposerState?: (input: {
        courseId: string;
        knowledgeStatus: "idle" | "loading" | "ready" | "missing" | "error";
        modelReady: boolean;
      }) => { disabled: boolean; placeholder: string };
    }).courseQaComposerState;

    expect(resolve).toBeTypeOf("function");
    expect(resolve!({ courseId: "", knowledgeStatus: "idle", modelReady: true })).toEqual({
      disabled: true,
      placeholder: "请选择课程后开始答疑",
    });
    expect(resolve!({ courseId: "course-1", knowledgeStatus: "missing", modelReady: true })).toEqual({
      disabled: true,
      placeholder: "当前课程尚未发布资料，请先到课程资料库发布",
    });
    expect(resolve!({ courseId: "course-1", knowledgeStatus: "loading", modelReady: true })).toEqual({
      disabled: true,
      placeholder: "正在加载当前课程资料…",
    });
    expect(resolve!({ courseId: "course-1", knowledgeStatus: "ready", modelReady: false })).toEqual({
      disabled: true,
      placeholder: "请先完成主模型设置",
    });
    expect(resolve!({ courseId: "course-1", knowledgeStatus: "ready", modelReady: true })).toEqual({
      disabled: false,
      placeholder: "输入你的课程问题",
    });
  });
});
