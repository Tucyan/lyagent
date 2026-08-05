import { createHash } from "node:crypto";
import { SafeFilesystem } from "../core/safe-filesystem.js";

export interface BatchResultSnapshot {
  batchId: string;
  jobId: string;
  sessionId: string;
  studentName: string;
  studentNumber: string;
  submissionTitle: string;
  reviewStatus: "needs_review" | "confirmed";
  version: number;
  attemptCount: number;
  result: unknown;
  updatedAt: string;
  resultHash: string;
}

export type BatchResultSnapshotInput = Omit<BatchResultSnapshot, "resultHash"> & { resultHash?: undefined };

export class GradingSummaryService {
  private readonly filesystem: SafeFilesystem;
  private readonly writerTails = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.filesystem = new SafeFilesystem(root, { allowedExtensions: new Set([".json", ".md", ".csv"]) });
  }

  async writeSnapshot(input: BatchResultSnapshotInput): Promise<BatchResultSnapshot> {
    const withoutHash = { ...input };
    delete withoutHash.resultHash;
    const snapshot = { ...withoutHash, resultHash: hashJson(withoutHash) } as BatchResultSnapshot;
    await this.withWriter(input.batchId, async () => {
      await this.filesystem.writeText(this.jsonPath(input.batchId, input.jobId, input.attemptCount), stringify(snapshot));
      await this.filesystem.writeText(this.markdownPath(input.batchId, input.jobId, input.attemptCount), renderMarkdown(snapshot));
    });
    return snapshot;
  }

  async readSnapshot(batchId: string, jobId: string, attemptCount: number): Promise<BatchResultSnapshot | undefined> {
    try {
      const snapshot = JSON.parse(await this.filesystem.readText(this.jsonPath(batchId, jobId, attemptCount))) as BatchResultSnapshot;
      const { resultHash, ...withoutHash } = snapshot;
      return resultHash === hashJson(withoutHash) ? snapshot : undefined;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async rebuildCsv(batchId: string, jobs: Array<{ id: string; attemptCount: number }>): Promise<string> {
    let content = "";
    await this.withWriter(batchId, async () => {
      const snapshots = (await Promise.all(jobs.map((job) => this.readSnapshot(batchId, job.id, job.attemptCount))))
        .filter((snapshot, index): snapshot is BatchResultSnapshot => {
          if (!snapshot) return false;
          const job = jobs[index];
          return job !== undefined && snapshot.attemptCount === job.attemptCount;
        })
        .sort((left, right) => left.studentNumber.localeCompare(right.studentNumber, "zh-CN") || left.jobId.localeCompare(right.jobId));
      const header = ["学号", "学生姓名", "作业名称", "总分", "满分", "总置信度", "复核状态"];
      const rows = snapshots.map((snapshot) => {
        const result = snapshot.result as { score?: { earned?: unknown; possible?: unknown }; confidence?: { overall?: unknown } };
        return [
          snapshot.studentNumber,
          snapshot.studentName,
          snapshot.submissionTitle,
          printable(result.score?.earned),
          printable(result.score?.possible),
          printable(result.confidence?.overall),
          snapshot.reviewStatus === "confirmed" ? "已确认" : "待复核",
        ];
      });
      content = `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
      await this.filesystem.writeText(`batch-grading/${batchId}/summary.csv`, content);
    });
    return content;
  }

  async readCsv(batchId: string): Promise<string> {
    return this.filesystem.readText(`batch-grading/${batchId}/summary.csv`);
  }

  async ensureSnapshotArtifacts(batchId: string, jobId: string, attemptCount: number): Promise<BatchResultSnapshot | undefined> {
    const snapshot = await this.readSnapshot(batchId, jobId, attemptCount);
    if (!snapshot) return undefined;
    await this.withWriter(batchId, async () => {
      try {
        await this.filesystem.readText(this.markdownPath(batchId, jobId, attemptCount));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.filesystem.writeText(this.markdownPath(batchId, jobId, attemptCount), renderMarkdown(snapshot));
      }
    });
    return snapshot;
  }

  private async withWriter(batchId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.writerTails.get(batchId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.writerTails.set(batchId, tail);
    await previous;
    try { await action(); }
    finally {
      release();
      if (this.writerTails.get(batchId) === tail) this.writerTails.delete(batchId);
    }
  }

  private jsonPath(batchId: string, jobId: string, attemptCount: number): string {
    return `batch-grading/${batchId}/results/${jobId}-attempt-${attemptCount}.json`;
  }

  private markdownPath(batchId: string, jobId: string, attemptCount: number): string {
    return `batch-grading/${batchId}/results/${jobId}-attempt-${attemptCount}.md`;
  }
}

function renderMarkdown(snapshot: BatchResultSnapshot): string {
  const result = snapshot.result as {
    score?: { earned?: unknown; possible?: unknown };
    decisions?: { strengths?: unknown[]; improvements?: unknown[] };
  };
  const lines = [
    `# ${snapshot.submissionTitle}批改预览`,
    "",
    `- 学生：${snapshot.studentName}（${snapshot.studentNumber}）`,
    `- 总分：${printable(result.score?.earned)}/${printable(result.score?.possible)}`,
    `- 状态：${snapshot.reviewStatus === "confirmed" ? "已确认" : "待教师复核"}`,
  ];
  const strengths = result.decisions?.strengths?.map(String) ?? [];
  const improvements = result.decisions?.improvements?.map(String) ?? [];
  if (strengths.length) lines.push("", "## 主要优点", "", ...strengths.map((item) => `- ${item}`));
  if (improvements.length) lines.push("", "## 改进建议", "", ...improvements.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}

function printable(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function csvCell(value: string): string {
  const protectedValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(protectedValue) ? `"${protectedValue.replaceAll('"', '""')}"` : protectedValue;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
