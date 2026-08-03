import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import { rubricSchema, validateRubric, type Rubric, type RubricValidation } from "../schemas/rubric.js";

export type RubricSourceRole = "rubric_draft" | "note";

export interface RubricSourceInput {
  role: RubricSourceRole;
  name: string;
  content: string;
}

export interface RubricSource {
  id: string;
  role: RubricSourceRole;
  name: string;
  size: number;
}

export interface RubricAssignment {
  id: string;
  title: string;
  totalScore: number;
  requirements: string;
  sources: RubricSource[];
  createdAt: string;
  updatedAt: string;
}

export interface RubricDraft {
  version: number;
  rubric: Rubric;
  baseRubricVersion?: number;
  updatedAt: string;
}

export interface FrozenRubricVersion {
  version: number;
  hash: string;
  frozenAt: string;
  rubric: Rubric;
}

export class RubricServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RubricServiceError";
  }
}

export class RubricConflictError extends RubricServiceError {
  constructor() {
    super("Rubric draft has changed; refresh before editing");
    this.name = "RubricConflictError";
  }
}

export class RubricValidationError extends RubricServiceError {
  constructor(public readonly validation: RubricValidation) {
    super("Rubric cannot be frozen until validation errors are resolved");
    this.name = "RubricValidationError";
  }
}

export class RubricService {
  public readonly root: string;
  private readonly filesystem: SafeFilesystem;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.filesystem = new SafeFilesystem(this.root, { allowedExtensions: new Set([".json", ".txt", ".md"]) });
  }

  async createAssignment(input: { title: string; totalScore: number; requirements: string; sources: RubricSourceInput[] }): Promise<RubricAssignment> {
    const title = input.title.trim();
    const requirements = input.requirements.trim();
    if (title.length === 0 || title.length > 120) throw new RubricServiceError("Assignment title must be between 1 and 120 characters");
    if (!isScore(input.totalScore) || input.totalScore === 0) throw new RubricServiceError("Assignment total score must be a positive score with at most two decimal places");
    if (requirements.length === 0 || requirements.length > 100_000) throw new RubricServiceError("Assignment requirements must be between 1 and 100000 characters");
    if (input.sources.length > 10) throw new RubricServiceError("An assignment can contain at most 10 source files");
    const totalBytes = input.sources.reduce((total, source) => total + Buffer.byteLength(source.content), 0);
    if (totalBytes > 5 * 1024 * 1024) throw new RubricServiceError("Rubric sources exceed the 5 MiB limit");

    const assignmentId = randomUUID();
    const sources: RubricSource[] = [];
    for (const source of input.sources) {
      if (source.role !== "rubric_draft" && source.role !== "note") throw new RubricServiceError("Rubric source role is invalid");
      const name = source.name.trim();
      const size = Buffer.byteLength(source.content);
      if (name.length === 0 || name.length > 160) throw new RubricServiceError("Rubric source name must be between 1 and 160 characters");
      if (size > 1024 * 1024) throw new RubricServiceError(`Rubric source is too large: ${name}`);
      const stored: RubricSource = { id: randomUUID(), role: source.role, name, size };
      await this.filesystem.writeText(this.sourceFile(assignmentId, stored.id), source.content);
      sources.push(stored);
    }
    const now = new Date().toISOString();
    const assignment: RubricAssignment = { id: assignmentId, title, totalScore: input.totalScore, requirements, sources, createdAt: now, updatedAt: now };
    await this.writeAssignment(assignment);
    return assignment;
  }

  async listAssignments(): Promise<RubricAssignment[]> {
    try {
      const entries = await readdir(path.join(this.root, "assignments"), { withFileTypes: true });
      const assignments = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.getAssignment(entry.name)));
      return assignments.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getAssignment(assignmentId: string): Promise<RubricAssignment> {
    try {
      const assignment = await this.readJson<RubricAssignment>(this.assignmentFile(assignmentId));
      if (assignment.id !== assignmentId) throw new RubricServiceError("Assignment was not found");
      return assignment;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RubricServiceError("Assignment was not found");
      throw error;
    }
  }

  async renameAssignment(assignmentId: string, title: string): Promise<RubricAssignment> {
    const assignment = await this.getAssignment(assignmentId);
    const normalized = title.trim();
    if (normalized.length === 0 || normalized.length > 120) throw new RubricServiceError("Assignment title must be between 1 and 120 characters");
    const updated: RubricAssignment = { ...assignment, title: normalized, updatedAt: new Date().toISOString() };
    await this.writeAssignment(updated);
    return updated;
  }

  async readSource(assignmentId: string, sourceId: string): Promise<string> {
    const assignment = await this.getAssignment(assignmentId);
    if (!assignment.sources.some((source) => source.id === sourceId)) throw new RubricServiceError("Rubric source was not found");
    return this.filesystem.readText(this.sourceFile(assignmentId, sourceId));
  }

  async createDraft(assignmentId: string, rubric: Rubric, baseRubricVersion?: number): Promise<RubricDraft> {
    await this.getAssignment(assignmentId);
    if (await this.getDraft(assignmentId)) throw new RubricServiceError("Assignment already has an editable rubric draft");
    if (baseRubricVersion !== undefined) await this.getVersion(assignmentId, baseRubricVersion);
    this.assertRubricMatchesAssignment(await this.getAssignment(assignmentId), rubric);
    const now = new Date().toISOString();
    const draft: RubricDraft = { version: 1, rubric: rubricSchema.parse(rubric), updatedAt: now, ...(baseRubricVersion === undefined ? {} : { baseRubricVersion }) };
    await this.writeDraft(assignmentId, draft);
    return draft;
  }

  async getDraft(assignmentId: string): Promise<RubricDraft | undefined> {
    await this.getAssignment(assignmentId);
    try {
      return await this.readJson<RubricDraft>(this.draftFile(assignmentId));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async replaceDraft(assignmentId: string, expectedVersion: number, rubric: Rubric): Promise<RubricDraft> {
    const assignment = await this.getAssignment(assignmentId);
    const draft = await this.requireDraft(assignmentId);
    if (draft.version !== expectedVersion) throw new RubricConflictError();
    this.assertRubricMatchesAssignment(assignment, rubric);
    const updated: RubricDraft = { ...draft, version: draft.version + 1, rubric: rubricSchema.parse(rubric), updatedAt: new Date().toISOString() };
    await this.writeDraft(assignmentId, updated);
    await this.writeAssignment({ ...assignment, updatedAt: updated.updatedAt });
    return updated;
  }

  async freeze(assignmentId: string, expectedVersion: number, acknowledgedWarningCodes: string[]): Promise<FrozenRubricVersion> {
    const assignment = await this.getAssignment(assignmentId);
    const draft = await this.requireDraft(assignmentId);
    if (draft.version !== expectedVersion) throw new RubricConflictError();
    const validation = validateRubric(draft.rubric);
    if (validation.errors.length > 0) throw new RubricValidationError(validation);
    const requiredWarnings = validation.warnings.map((warning) => warning.code).sort();
    if (JSON.stringify([...new Set(acknowledgedWarningCodes)].sort()) !== JSON.stringify(requiredWarnings)) {
      throw new RubricServiceError("Current rubric warnings must be acknowledged before freezing");
    }
    const versions = await this.listVersions(assignmentId);
    const version = (versions[0]?.version ?? 0) + 1;
    const frozenAt = new Date().toISOString();
    const hash = hashJson({ assignmentId, version, rubric: draft.rubric });
    const frozen: FrozenRubricVersion = { version, hash, frozenAt, rubric: draft.rubric };
    await this.filesystem.writeText(this.versionFile(assignmentId, version), stringify(frozen));
    await this.filesystem.removeFile(this.draftFile(assignmentId));
    await this.writeAssignment({ ...assignment, updatedAt: frozenAt });
    return frozen;
  }

  async listVersions(assignmentId: string): Promise<FrozenRubricVersion[]> {
    await this.getAssignment(assignmentId);
    const entries = await this.filesystem.listFiles(this.rubricsDirectory(assignmentId));
    const versions = await Promise.all(entries
      .filter((entry) => /^rubric-v\d+\.json$/.test(entry))
      .map((entry) => this.readJson<FrozenRubricVersion>(`${this.rubricsDirectory(assignmentId)}/${entry}`)));
    return versions.sort((left, right) => right.version - left.version);
  }

  async getVersion(assignmentId: string, version: number): Promise<FrozenRubricVersion> {
    await this.getAssignment(assignmentId);
    try {
      return await this.readJson<FrozenRubricVersion>(this.versionFile(assignmentId, version));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RubricServiceError("Frozen rubric version was not found");
      throw error;
    }
  }

  async createRevision(assignmentId: string, version: number): Promise<RubricDraft> {
    const frozen = await this.getVersion(assignmentId, version);
    return this.createDraft(assignmentId, frozen.rubric, frozen.version);
  }

  async renderVersionMarkdown(assignmentId: string, version: number): Promise<string> {
    const frozen = await this.getVersion(assignmentId, version);
    return renderRubricMarkdown(frozen.rubric);
  }

  private async requireDraft(assignmentId: string): Promise<RubricDraft> {
    const draft = await this.getDraft(assignmentId);
    if (!draft) throw new RubricServiceError("Assignment does not have an editable rubric draft");
    return draft;
  }

  private assertRubricMatchesAssignment(assignment: RubricAssignment, rubric: Rubric): void {
    const validation = validateRubric(rubric);
    if (validation.errors.length > 0) throw new RubricValidationError(validation);
    if (rubric.totalScore !== assignment.totalScore) throw new RubricServiceError("Rubric total score must match the assignment total score");
  }

  private async writeAssignment(assignment: RubricAssignment): Promise<void> {
    await this.filesystem.writeText(this.assignmentFile(assignment.id), stringify(assignment));
  }

  private async writeDraft(assignmentId: string, draft: RubricDraft): Promise<void> {
    await this.filesystem.writeText(this.draftFile(assignmentId), stringify(draft));
  }

  private async readJson<T>(relativePath: string): Promise<T> {
    return JSON.parse(await this.filesystem.readText(relativePath)) as T;
  }

  private assignmentFile(assignmentId: string): string {
    return `assignments/${assignmentId}/assignment.json`;
  }

  private sourceFile(assignmentId: string, sourceId: string): string {
    return `assignments/${assignmentId}/sources/${sourceId}.txt`;
  }

  private rubricsDirectory(assignmentId: string): string {
    return `assignments/${assignmentId}/rubrics`;
  }

  private draftFile(assignmentId: string): string {
    return `${this.rubricsDirectory(assignmentId)}/draft.json`;
  }

  private versionFile(assignmentId: string, version: number): string {
    return `${this.rubricsDirectory(assignmentId)}/rubric-v${version}.json`;
  }
}

export function renderRubricMarkdown(rubric: Rubric): string {
  const lines = [`# 评分表`, "", `- 制度：${modeLabel(rubric.mode)}`, `- 总分：${rubric.totalScore}`, ""];
  if (rubric.mode === "additive" || rubric.mode === "hybrid") {
    lines.push("## 评分项目", "", "| 项目 | 最高分 | 评分策略 | 说明 |", "| --- | ---: | --- | --- |");
    for (const criterion of rubric.criteria) lines.push(`| ${criterion.name} | ${criterion.maxScore} | ${criterion.scorePolicy} | ${criterion.description} |`);
  }
  if (rubric.mode === "deductive" || rubric.mode === "hybrid") {
    const rules = rubric.mode === "deductive" ? rubric.rules : rubric.deductionRules;
    lines.push("", "## 扣分规则", "", "| 规则 | 单次扣分 | 最大扣分 | 条件 |", "| --- | ---: | ---: | --- |");
    for (const rule of rules) lines.push(`| ${rule.name} | ${rule.deduction} | ${rule.maxDeduction} | ${rule.condition} |`);
  }
  if (rubric.mode === "hybrid" && rubric.bonusRules.length > 0) {
    lines.push("", "## 奖励规则", "", "| 规则 | 单次奖励 | 最大奖励 | 条件 |", "| --- | ---: | ---: | --- |");
    for (const rule of rubric.bonusRules) lines.push(`| ${rule.name} | ${rule.bonus} | ${rule.maxBonus} | ${rule.condition} |`);
  }
  return `${lines.join("\n")}\n`;
}

function modeLabel(mode: Rubric["mode"]): string {
  return mode === "additive" ? "加分制" : mode === "deductive" ? "减分制" : "混合制";
}

function isScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && Math.abs(Math.round(value * 100) - value * 100) < 1e-8;
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}
