import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve(process.argv[2] ?? "tests/fixtures/batch-grading/generated");
const count = Number(process.argv[3] ?? 30);
if (!Number.isInteger(count) || count < 30 || count > 120) throw new Error("Fixture count must be an integer from 30 to 120");
await mkdir(output, { recursive: true });
for (let index = 1; index <= count; index += 1) {
  const number = `2026${String(index).padStart(4, "0")}`;
  const name = `合成学生${index}`;
  const topic = ["生成式AI学习助手", "校园节能分析", "公共数据可视化", "数字素养调研"][index % 4];
  const content = [
    `# ${topic}研究报告`,
    "",
    `作者：${name}`,
    `学号：${number}`,
    "",
    "## 问题与目标",
    "",
    `本报告围绕${topic}提出一个可验证的问题，并说明预期使用场景。`,
    "",
    "## 方法",
    "",
    "报告使用合成案例、分步分析与边界讨论，所有数据均为测试用途。",
    "",
    "## 结果与反思",
    "",
    `第 ${index} 号样例给出结构化结论，并指出证据范围与后续改进方向。`,
    "",
  ].join("\n");
  await writeFile(path.join(output, `${number}_${name}_${topic}.md`), content, "utf8");
}
console.log(`Generated ${count} synthetic Markdown reports in ${output}`);

