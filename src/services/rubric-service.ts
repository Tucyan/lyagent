import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import { rubricSchema, validateRubric, type DeductionRule, type Rubric, type RubricValidation } from "../schemas/rubric.js";

export type RubricSourceRole = "rubric_draft" | "note";
export const RUBRIC_SAFE_PROCESS_SUMMARY = "Agent 正在分析作业要求、参考资料和现有评分表，并准备结构化评分规则。";

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
  courseId?: string;
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

export interface RubricDesignSession {
  assignmentId: string;
  selectedMode: Rubric["mode"];
  updatedAt: string;
  messages: RubricConversationMessage[];
}

export interface RubricConversationTool {
  id: string;
  name: string;
  label: string;
  summary: string;
  status: "completed" | "failed";
}

export type RubricConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; process?: string; tools?: RubricConversationTool[]; options?: string[] };

export interface RubricServiceOptions {
  afterFreezeVersionWrite?: (assignmentId: string, version: number) => void | Promise<void>;
  afterFreezeDraftDelete?: (assignmentId: string, version: number) => void | Promise<void>;
}

interface RubricFreezeCommit {
  draftVersion: number;
  frozenVersion: number;
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
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly afterFreezeVersionWrite?: RubricServiceOptions["afterFreezeVersionWrite"];
  private readonly afterFreezeDraftDelete?: RubricServiceOptions["afterFreezeDraftDelete"];

  constructor(root: string, options: RubricServiceOptions = {}) {
    this.root = path.resolve(root);
    this.filesystem = new SafeFilesystem(this.root, { allowedExtensions: new Set([".json", ".txt", ".md"]) });
    this.afterFreezeVersionWrite = options.afterFreezeVersionWrite;
    this.afterFreezeDraftDelete = options.afterFreezeDraftDelete;
  }

  async createAssignment(input: { courseId?: string; title: string; totalScore: number; requirements: string; sources: RubricSourceInput[] }): Promise<RubricAssignment> {
    const title = input.title.trim();
    const requirements = input.requirements.trim();
    if (title.length === 0 || title.length > 120) throw new RubricServiceError("Assignment title must be between 1 and 120 characters");
    if (!isScore(input.totalScore) || input.totalScore === 0) throw new RubricServiceError("Assignment total score must be a positive score with at most two decimal places");
    if (requirements.length > 100_000) throw new RubricServiceError("Assignment requirements must contain at most 100000 characters");
    if (requirements.length === 0 && !input.sources.some((source) => source.content.trim().length > 0)) {
      throw new RubricServiceError("Assignment requirements or at least one non-empty source is required");
    }
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
    const assignment: RubricAssignment = { id: assignmentId, ...(input.courseId ? { courseId: input.courseId } : {}), title, totalScore: input.totalScore, requirements, sources, createdAt: now, updatedAt: now };
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
    return this.mutateAssignment(assignmentId, async () => {
      const assignment = await this.getAssignment(assignmentId);
      const normalized = title.trim();
      if (normalized.length === 0 || normalized.length > 120) throw new RubricServiceError("Assignment title must be between 1 and 120 characters");
      const updated: RubricAssignment = { ...assignment, title: normalized, updatedAt: new Date().toISOString() };
      await this.writeAssignment(updated);
      return updated;
    });
  }

  async bindCourse(assignmentId: string, courseId: string): Promise<RubricAssignment> {
    return this.mutateAssignment(assignmentId, async () => {
      const assignment = await this.getAssignment(assignmentId);
      if (assignment.courseId && assignment.courseId !== courseId) throw new RubricServiceError("Rubric assignment is already bound to another course");
      if (assignment.courseId === courseId) return assignment;
      const updated: RubricAssignment = { ...assignment, courseId, updatedAt: new Date().toISOString() };
      await this.writeAssignment(updated);
      return updated;
    });
  }

  async bindUnboundAssignments(courseId: string): Promise<void> {
    for (const assignment of await this.listAssignments()) {
      if (!assignment.courseId) await this.bindCourse(assignment.id, courseId);
    }
  }

  async deleteAssignment(assignmentId: string): Promise<void> {
    return this.mutateAssignment(assignmentId, async () => {
      await this.getAssignment(assignmentId);
      await this.filesystem.removeDirectory(`assignments/${assignmentId}`);
    });
  }

  async readSource(assignmentId: string, sourceId: string): Promise<string> {
    const assignment = await this.getAssignment(assignmentId);
    if (!assignment.sources.some((source) => source.id === sourceId)) throw new RubricServiceError("Rubric source was not found");
    return this.filesystem.readText(this.sourceFile(assignmentId, sourceId));
  }

  async selectMode(assignmentId: string, selectedMode: Rubric["mode"]): Promise<RubricDesignSession> {
    return this.mutateAssignment(assignmentId, async () => {
      await this.getAssignment(assignmentId);
      if (selectedMode !== "additive" && selectedMode !== "deductive" && selectedMode !== "hybrid") throw new RubricServiceError("Rubric scoring mode is invalid");
      const existing = await this.getDesignSession(assignmentId);
      if (existing?.selectedMode === selectedMode) return existing;
      if (await this.getDraftUnlocked(assignmentId)) throw new RubricServiceError("The scoring mode cannot change after a rubric draft exists");
      if ((await this.listVersions(assignmentId)).length > 0) throw new RubricServiceError("The scoring mode cannot change after a rubric version is frozen");
      const session: RubricDesignSession = { assignmentId, selectedMode, updatedAt: new Date().toISOString(), messages: [] };
      await this.writeDesignSession(assignmentId, session);
      return session;
    });
  }

  async getDesignSession(assignmentId: string): Promise<RubricDesignSession | undefined> {
    await this.getAssignment(assignmentId);
    try {
      const session = await this.readJson<RubricDesignSession>(this.designSessionFile(assignmentId));
      if (session.assignmentId !== assignmentId) throw new RubricServiceError("Rubric design session was not found");
      return { ...session, messages: sanitizeConversationMessages(session.messages ?? []) };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async appendConversationTurn(
    assignmentId: string,
    user: Extract<RubricConversationMessage, { role: "user" }>,
    assistant: Extract<RubricConversationMessage, { role: "assistant" }>,
  ): Promise<RubricDesignSession> {
    return this.mutateAssignment(assignmentId, async () => {
      const assignment = await this.getAssignment(assignmentId);
      const session = await this.getDesignSession(assignmentId);
      if (!session) throw new RubricServiceError("Select a scoring mode before starting rubric design");
      const updatedAt = new Date().toISOString();
      const updated: RubricDesignSession = {
        ...session,
        updatedAt,
        messages: [...session.messages, user, sanitizeAssistantMessage(assistant)].slice(-40),
      };
      await this.writeDesignSession(assignmentId, updated);
      await this.writeAssignment({ ...assignment, updatedAt });
      return updated;
    });
  }

  async createDraft(assignmentId: string, rubric: Rubric, baseRubricVersion?: number): Promise<RubricDraft> {
    return this.mutateAssignment(assignmentId, (waited) => this.createDraftUnlocked(assignmentId, rubric, baseRubricVersion, waited));
  }

  private async createDraftUnlocked(assignmentId: string, rubric: Rubric, baseRubricVersion?: number, conflictIfDraftExists = false): Promise<RubricDraft> {
    const assignment = await this.getAssignment(assignmentId);
    if (await this.getDraftUnlocked(assignmentId)) {
      if (conflictIfDraftExists) throw new RubricConflictError();
      throw new RubricServiceError("Assignment already has an editable rubric draft");
    }
    if (baseRubricVersion === undefined && (await this.listVersions(assignmentId)).length > 0) {
      throw new RubricServiceError("Create a revision from a frozen rubric version before editing again");
    }
    if (baseRubricVersion !== undefined) await this.getVersion(assignmentId, baseRubricVersion);
    await this.assertRubricMatchesAssignment(assignment, rubric);
    const now = new Date().toISOString();
    const draft: RubricDraft = { version: 1, rubric: rubricSchema.parse(rubric), updatedAt: now, ...(baseRubricVersion === undefined ? {} : { baseRubricVersion }) };
    await this.writeDraft(assignmentId, draft);
    return draft;
  }

  async getDraft(assignmentId: string): Promise<RubricDraft | undefined> {
    return this.mutateAssignment(assignmentId, () => this.getDraftUnlocked(assignmentId));
  }

  private async getDraftUnlocked(assignmentId: string): Promise<RubricDraft | undefined> {
    await this.getAssignment(assignmentId);
    await this.reconcileFreezeCommit(assignmentId);
    try {
      return await this.readJson<RubricDraft>(this.draftFile(assignmentId));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async replaceDraft(assignmentId: string, expectedVersion: number, rubric: Rubric): Promise<RubricDraft> {
    return this.mutateAssignment(assignmentId, async () => {
      const assignment = await this.getAssignment(assignmentId);
      const draft = await this.getDraftUnlocked(assignmentId);
      if (!draft) throw new RubricConflictError();
      if (draft.version !== expectedVersion) throw new RubricConflictError();
      await this.assertRubricMatchesAssignment(assignment, rubric);
      const updated: RubricDraft = { ...draft, version: draft.version + 1, rubric: rubricSchema.parse(rubric), updatedAt: new Date().toISOString() };
      await this.writeDraft(assignmentId, updated);
      await this.writeAssignment({ ...assignment, updatedAt: updated.updatedAt });
      return updated;
    });
  }

  async freeze(assignmentId: string, expectedVersion: number, acknowledgedWarningCodes: string[]): Promise<FrozenRubricVersion> {
    return this.mutateAssignment(assignmentId, async () => {
      const assignment = await this.getAssignment(assignmentId);
      const draft = await this.getDraftUnlocked(assignmentId);
      if (!draft) throw new RubricConflictError();
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
      await this.writeFreezeCommit(assignmentId, { draftVersion: draft.version, frozenVersion: version });
      await this.filesystem.writeText(this.versionFile(assignmentId, version), stringify(frozen));
      await this.afterFreezeVersionWrite?.(assignmentId, version);
      await this.filesystem.removeFile(this.draftFile(assignmentId));
      await this.afterFreezeDraftDelete?.(assignmentId, version);
      await this.filesystem.removeFile(this.freezeCommitFile(assignmentId));
      await this.writeAssignment({ ...assignment, updatedAt: frozenAt });
      return frozen;
    });
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
    return this.mutateAssignment(assignmentId, async (waited) => {
      const frozen = await this.getVersion(assignmentId, version);
      return this.createDraftUnlocked(assignmentId, frozen.rubric, frozen.version, waited);
    });
  }

  async renderVersionMarkdown(assignmentId: string, version: number): Promise<string> {
    const frozen = await this.getVersion(assignmentId, version);
    return renderRubricMarkdown(frozen.rubric);
  }

  private async requireDraft(assignmentId: string): Promise<RubricDraft> {
    const draft = await this.getDraftUnlocked(assignmentId);
    if (!draft) throw new RubricServiceError("Assignment does not have an editable rubric draft");
    return draft;
  }

  private async assertRubricMatchesAssignment(assignment: RubricAssignment, rubric: Rubric): Promise<void> {
    const session = await this.getDesignSession(assignment.id);
    if (!session) throw new RubricServiceError("Select a scoring mode before creating a rubric draft");
    if (session.selectedMode !== rubric.mode) throw new RubricServiceError("Rubric mode does not match the selected scoring mode");
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

  private async writeDesignSession(assignmentId: string, session: RubricDesignSession): Promise<void> {
    await this.filesystem.writeText(this.designSessionFile(assignmentId), stringify(session));
  }

  private async writeFreezeCommit(assignmentId: string, commit: RubricFreezeCommit): Promise<void> {
    await this.filesystem.writeText(this.freezeCommitFile(assignmentId), stringify(commit));
  }

  private async reconcileFreezeCommit(assignmentId: string): Promise<void> {
    let commit: RubricFreezeCommit;
    try {
      commit = await this.readJson<RubricFreezeCommit>(this.freezeCommitFile(assignmentId));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      await this.getVersion(assignmentId, commit.frozenVersion);
    } catch (error: unknown) {
      if (error instanceof RubricServiceError && error.message === "Frozen rubric version was not found") return;
      throw error;
    }
    await this.removeFileIfPresent(this.draftFile(assignmentId));
    await this.removeFileIfPresent(this.freezeCommitFile(assignmentId));
  }

  private async removeFileIfPresent(relativePath: string): Promise<void> {
    try {
      await this.filesystem.removeFile(relativePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async mutateAssignment<T>(assignmentId: string, action: (waited: boolean) => Promise<T>): Promise<T> {
    const waited = this.mutationTails.has(assignmentId);
    const previous = this.mutationTails.get(assignmentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.mutationTails.set(assignmentId, tail);
    await previous.catch(() => undefined);
    try {
      return await action(waited);
    } finally {
      release?.();
      if (this.mutationTails.get(assignmentId) === tail) this.mutationTails.delete(assignmentId);
    }
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

  private freezeCommitFile(assignmentId: string): string {
    return `${this.rubricsDirectory(assignmentId)}/freeze-commit.json`;
  }

  private designSessionFile(assignmentId: string): string {
    return `assignments/${assignmentId}/design-session.json`;
  }

  private versionFile(assignmentId: string, version: number): string {
    return `${this.rubricsDirectory(assignmentId)}/rubric-v${version}.json`;
  }
}

export function renderRubricMarkdown(rubric: Rubric): string {
  const lines = [`# 评分表`, "", `- 制度：${modeLabel(rubric.mode)}`, `- 总分：${rubric.totalScore}`, ""];
  if (rubric.mode === "additive" || rubric.mode === "hybrid") {
    lines.push(`- 允许部分得分：${rubric.partialCreditAllowed ? "是" : "否"}`, "", "## 评分项目", "", "| 项目 | 最高分 | 评分策略 | 分析依据要求 | 说明 |", "| --- | ---: | --- | --- | --- |");
    for (const criterion of rubric.criteria) {
      lines.push(`| ${markdownCell(criterion.name)} | ${criterion.maxScore} | ${scorePolicyMarkdownLabel(criterion.scorePolicy)} | ${criterion.evidenceRequired ? "需要评分分析依据" : "不强制分析依据"} | ${markdownCell(criterion.description)} |`);
    }
    for (const criterion of rubric.criteria.filter((item) => (item.levels?.length ?? 0) > 0)) {
      lines.push("", `### ${markdownCell(criterion.name)}：评分等级`, "", "| 等级 | 分值/区间 | 达成条件 |", "| --- | ---: | --- |");
      for (const level of criterion.levels!) lines.push(`| ${markdownCell(level.id)} | ${scoreRange(level.minScore, level.maxScore)} | ${markdownCell(level.condition)} |`);
    }
  }
  if (rubric.mode === "deductive" || rubric.mode === "hybrid") {
    const rules = rubric.mode === "deductive" ? rubric.rules : rubric.deductionRules;
    lines.push("", "## 扣分规则", "", "| 规则 | 扣分方式 | 最大扣分 | 分析依据要求 | 重叠组 | 条件 |", "| --- | --- | ---: | --- | --- | --- |");
    for (const rule of rules) lines.push(`| ${markdownCell(rule.name)} | ${deductionRuleLabel(rule)} | ${rule.maxDeduction} | ${rule.evidenceRequired ? "需要评分分析依据" : "不强制分析依据"} | ${rule.overlapGroup ?? "—"} | ${markdownCell(rule.condition)} |`);
  }
  if (rubric.mode === "hybrid" && rubric.bonusRules.length > 0) {
    lines.push("", "## 奖励规则", "", "| 规则 | 单次奖励 | 最大奖励 | 计算方式 | 分析依据要求 | 重叠组 | 条件 |", "| --- | ---: | ---: | --- | --- | --- | --- |");
    for (const rule of rubric.bonusRules) lines.push(`| ${markdownCell(rule.name)} | ${rule.bonus} | ${rule.maxBonus} | ${occurrenceLabel(rule.occurrence)} | ${rule.evidenceRequired ? "需要评分分析依据" : "不强制分析依据"} | ${rule.overlapGroup ?? "—"} | ${markdownCell(rule.condition)} |`);
  }
  if (rubric.mode !== "additive" && rubric.overlapGroups.length > 0) {
    lines.push("", "## 重叠规则组", "", "| 组 ID | 聚合方式 |", "| --- | --- |");
    for (const group of rubric.overlapGroups) lines.push(`| ${markdownCell(group.id)} | ${group.aggregation === "highest-only" ? "仅取最高项" : "累计"} |`);
  }
  return `${lines.join("\n")}\n`;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function scoreRange(minimum: number, maximum: number): string {
  return minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
}

function scorePolicyMarkdownLabel(policy: "exact-level" | "range" | "continuous"): string {
  return policy === "exact-level" ? "等级定分" : policy === "range" ? "区间评分" : "连续评分";
}

function occurrenceLabel(occurrence: "once" | "per-occurrence"): string {
  return occurrence === "once" ? "仅一次" : "按次计算";
}

function deductionRuleLabel(rule: DeductionRule): string {
  const policy = rule.amountPolicy ?? (rule.occurrence === "per-occurrence" ? "per-occurrence" : "fixed");
  if (policy === "range") return `1–${rule.maxDeduction} 分（整数区间）`;
  if (policy === "per-occurrence") return `${rule.deduction} 分/次`;
  return `${rule.deduction} 分（固定一次）`;
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

function sanitizeConversationMessages(messages: RubricConversationMessage[]): RubricConversationMessage[] {
  return messages.map((message) => message.role === "assistant" ? sanitizeAssistantMessage(message) : message);
}

function sanitizeAssistantMessage(message: Extract<RubricConversationMessage, { role: "assistant" }>): Extract<RubricConversationMessage, { role: "assistant" }> {
  return message.process ? { ...message, process: RUBRIC_SAFE_PROCESS_SUMMARY } : message;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}
