import { readFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

const root = path.resolve("tests/fixtures/single-grading/ai-life-report");
const stem = "20260001_张晓明_生成式AI生活助手报告";

describe("single-grading acceptance fixtures", () => {
  it("keeps the supplied frozen rubric unchanged and provides all three report formats", async () => {
    const rubric = JSON.parse(await readFile(path.join(root, "rubric-v1.json"), "utf8"));
    expect(rubric).toMatchObject({ version: 1, hash: "949736269815dc30601a22a1fb1af84aee4752b11166685eb278e40becec4ae7", rubric: { mode: "deductive", totalScore: 100 } });
    expect(rubric.rubric.rules).toHaveLength(16);
    const markdown = await readFile(path.join(root, `${stem}.md`), "utf8");
    expect(markdown).toContain("本次提交未保留模型的实际系统输出");
    expect(markdown).toContain("问题、讨论与改进方案");
    const docx = unzipSync(new Uint8Array(await readFile(path.join(root, `${stem}.docx`))));
    const documentXml = new TextDecoder().decode(docx["word/document.xml"]);
    expect(documentXml).toContain("生成式 AI 生活助手的设计与实现报告");
    expect(documentXml).toContain("本次提交未保留模型的实际系统输出");
    expect(Buffer.from(await readFile(path.join(root, `${stem}.pdf`))).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
