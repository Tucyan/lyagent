import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SafeFilesystem, UnsafePathError } from "../core/safe-filesystem.js";

export type ImportStatus = "uploaded" | "ready" | "published" | "failed";

export interface Course {
  id: string;
  name: string;
  createdAt: string;
}

export interface ImportRecord {
  id: string;
  courseId: string;
  status: ImportStatus;
  sourceFiles: string[];
  draftVersion: number;
  manifestHash?: string;
  baseReleaseId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceSection {
  id: string;
  sourcePath: string;
  title: string;
  content: string;
}

export interface KnowledgePlan {
  documents: Array<{
    path: string;
    title: string;
    sectionIds: string[];
  }>;
}

export interface DraftSummary {
  version: number;
  manifestHash: string;
  tree: KnowledgeTreeEntry[];
}

export interface KnowledgeTreeEntry {
  path: string;
  type: "file";
  title: string;
  sourceSectionIds: string[];
}

export interface KnowledgeRelease {
  id: string;
  courseId: string;
  importId: string;
  manifestHash: string;
  createdAt: string;
}

export type DraftOperation =
  | { type: "rename"; path: string; name: string }
  | { type: "move"; path: string; directory: string }
  | { type: "delete"; path: string };

interface StoredImport extends ImportRecord {
  sections: SourceSection[];
}

interface StoredDraft extends DraftSummary {
  plan: KnowledgePlan;
}

export class KnowledgeReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeReleaseError";
  }
}

export class MaterialService {
  public readonly root: string;
  private readonly filesystem: SafeFilesystem;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.filesystem = new SafeFilesystem(this.root);
  }

  async createCourse(name: string): Promise<Course> {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || normalizedName.length > 100) {
      throw new KnowledgeReleaseError("Course name must be between 1 and 100 characters");
    }
    const course: Course = { id: randomUUID(), name: normalizedName, createdAt: new Date().toISOString() };
    await this.filesystem.writeText(this.courseFile(course.id), this.stringify(course));
    return course;
  }

  async listCourses(): Promise<Course[]> {
    const coursesRoot = path.join(this.root, "knowledge");
    try {
      const entries = await (await import("node:fs/promises")).readdir(coursesRoot, { withFileTypes: true });
      const courses = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => this.getCourse(entry.name)));
      return courses.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async createImport(courseId: string, files: Array<{ relativePath: string; content: string }>): Promise<ImportRecord> {
    await this.getCourse(courseId);
    if (files.length === 0 || files.length > 200) throw new KnowledgeReleaseError("An import must contain between 1 and 200 files");
    const sourceFiles = [...new Set(files.map((file) => file.relativePath))].sort();
    if (sourceFiles.length !== files.length) throw new KnowledgeReleaseError("An import cannot contain duplicate paths");
    const totalSize = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    if (totalSize > 100 * 1024 * 1024) throw new KnowledgeReleaseError("Import exceeds the 100 MB limit");

    const id = randomUUID();
    const now = new Date().toISOString();
    const sections: SourceSection[] = [];
    for (const file of files) {
      if (Buffer.byteLength(file.content) > 10 * 1024 * 1024) throw new KnowledgeReleaseError(`File is too large: ${file.relativePath}`);
      const safePath = this.sourceFile(id, file.relativePath);
      await this.filesystem.writeText(safePath, file.content);
      sections.push(...splitSections(file.relativePath, file.content));
    }
    const imported: StoredImport = {
      id,
      courseId,
      status: "uploaded",
      sourceFiles,
      sections,
      draftVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeImport(imported);
    return imported;
  }

  async getImport(courseId: string, importId: string): Promise<ImportRecord> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    return imported;
  }

  async listDrafts(courseId: string): Promise<ImportRecord[]> {
    await this.getCourse(courseId);
    const importsRoot = path.join(this.root, "inbox", "materials");
    try {
      const entries = await (await import("node:fs/promises")).readdir(importsRoot, { withFileTypes: true });
      const drafts = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => this.readImport(entry.name)));
      return drafts
        .filter((imported) => imported.courseId === courseId && imported.status === "ready")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(({ sections: _sections, ...imported }) => imported);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getSourceSections(courseId: string, importId: string): Promise<SourceSection[]> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    return imported.sections.map(({ content, ...section }) => ({ ...section, content }));
  }

  async renderPlan(courseId: string, importId: string, plan: KnowledgePlan, documentContents?: readonly string[]): Promise<DraftSummary> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    if (imported.status === "published") throw new KnowledgeReleaseError("Published imports cannot be edited");
    const tree = validatePlan(imported.sections, plan);
    const nextVersion = imported.draftVersion + 1;
    const staging = this.stagingDirectory(courseId, importId);
    const temporary = `${staging}.tmp-${randomUUID()}`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    const temporaryFilesystem = new SafeFilesystem(temporary);
    for (const [index, document] of plan.documents.entries()) {
      const content = documentContents?.[index]
        ?? document.sectionIds.map((id) => imported.sections.find((section) => section.id === id)?.content ?? "").join("\n");
      await temporaryFilesystem.writeText(document.path, content);
    }
    const manifestHash = await this.calculateManifestHash(temporaryFilesystem, tree);
    const draft: StoredDraft = { version: nextVersion, manifestHash, tree, plan };
    await temporaryFilesystem.writeText("index/tree.json", this.stringify(tree));
    await temporaryFilesystem.writeText("index/manifest.json", this.stringify({ manifestHash, files: tree.map((entry) => entry.path) }));
    await temporaryFilesystem.writeText("index/draft.json", this.stringify(draft));
    await rm(staging, { recursive: true, force: true });
    await mkdir(path.dirname(staging), { recursive: true });
    await rename(temporary, staging);

    const updated: StoredImport = { ...imported, status: "ready", draftVersion: nextVersion, manifestHash, updatedAt: new Date().toISOString() };
    await this.writeImport(updated);
    return draft;
  }

  async getDraft(courseId: string, importId: string): Promise<DraftSummary> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    if (imported.status !== "ready") throw new KnowledgeReleaseError("Import does not have a ready draft");
    return this.readJson<StoredDraft>(this.stagingFile(courseId, importId, "index/draft.json"));
  }

  async editDraft(courseId: string, importId: string, expectedVersion: number, operations: DraftOperation[]): Promise<DraftSummary> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    if (imported.status !== "ready") throw new KnowledgeReleaseError("Import does not have a ready draft");
    const draft = await this.readJson<StoredDraft>(this.stagingFile(courseId, importId, "index/draft.json"));
    if (draft.version !== expectedVersion) throw new KnowledgeReleaseError("Draft has changed; refresh before editing");
    const currentContents = await Promise.all(draft.plan.documents.map((document) => this.readDraftContent(courseId, importId, document.path)));
    const documents = draft.plan.documents.map((document) => ({ ...document, sectionIds: [...document.sectionIds] }));
    for (const operation of operations) {
      const index = documents.findIndex((document) => document.path === operation.path);
      if (index < 0) throw new KnowledgeReleaseError(`Draft document does not exist: ${operation.path}`);
      const document = documents[index];
      if (!document) throw new KnowledgeReleaseError("Draft document does not exist");
      if (operation.type === "delete") {
        throw new KnowledgeReleaseError("Documents containing source sections cannot be deleted; use rerun to restore the source-complete draft");
      }
      const directory = operation.type === "move" ? operation.directory : path.posix.dirname(document.path);
      const name = operation.type === "rename" ? operation.name : path.posix.basename(document.path);
      documents[index] = { ...document, path: directory === "." ? name : `${directory}/${name}` };
    }
    return this.renderPlan(courseId, importId, { documents }, currentContents);
  }

  async updateDraftContent(courseId: string, importId: string, expectedVersion: number, relativePath: string, content: string): Promise<DraftSummary> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    if (imported.status !== "ready") throw new KnowledgeReleaseError("Import does not have a ready draft");
    if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new KnowledgeReleaseError(`File is too large: ${relativePath}`);
    const draft = await this.readJson<StoredDraft>(this.stagingFile(courseId, importId, "index/draft.json"));
    if (draft.version !== expectedVersion) throw new KnowledgeReleaseError("Draft has changed; refresh before editing");
    if (!draft.tree.some((entry) => entry.path === relativePath)) {
      throw new KnowledgeReleaseError(`Draft document does not exist: ${relativePath}`);
    }

    const draftFilesystem = new SafeFilesystem(this.stagingDirectory(courseId, importId));
    await draftFilesystem.writeText(relativePath, content);
    const nextVersion = draft.version + 1;
    const manifestHash = await this.calculateManifestHash(draftFilesystem, draft.tree);
    const updatedDraft: StoredDraft = { ...draft, version: nextVersion, manifestHash };
    await draftFilesystem.writeText("index/manifest.json", this.stringify({ manifestHash, files: draft.tree.map((entry) => entry.path) }));
    await draftFilesystem.writeText("index/draft.json", this.stringify(updatedDraft));
    await this.writeImport({
      ...imported,
      draftVersion: nextVersion,
      manifestHash,
      updatedAt: new Date().toISOString(),
    });
    return updatedDraft;
  }

  async publish(courseId: string, importId: string, expectedVersion: number, expectedManifestHash: string): Promise<KnowledgeRelease> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    if (imported.status !== "ready") throw new KnowledgeReleaseError("Only ready imports can be published");
    const draft = await this.getDraft(courseId, importId);
    if (draft.version !== expectedVersion || draft.manifestHash !== expectedManifestHash) {
      throw new KnowledgeReleaseError("Draft has changed; refresh before publishing");
    }
    await this.validateDraftLinks(courseId, importId, draft.tree);
    const release: KnowledgeRelease = {
      id: randomUUID(),
      courseId,
      importId,
      manifestHash: draft.manifestHash,
      createdAt: new Date().toISOString(),
    };
    const staging = this.stagingDirectory(courseId, importId);
    const releaseDirectory = this.releaseDirectory(courseId, release.id);
    await mkdir(path.dirname(releaseDirectory), { recursive: true });
    await rename(staging, releaseDirectory);
    await this.filesystem.writeText(this.releaseFile(courseId, release.id, "index/release.json"), this.stringify(release));
    await this.filesystem.writeText(this.activeFile(courseId), this.stringify({ releaseId: release.id, manifestHash: release.manifestHash }));
    await this.writeImport({ ...imported, status: "published", updatedAt: new Date().toISOString() });
    return release;
  }

  async getActiveRelease(courseId: string): Promise<KnowledgeRelease | undefined> {
    await this.getCourse(courseId);
    try {
      const active = await this.readJson<{ releaseId: string }>(this.activeFile(courseId));
      return this.readJson<KnowledgeRelease>(this.releaseFile(courseId, active.releaseId, "index/release.json"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listReleases(courseId: string): Promise<KnowledgeRelease[]> {
    const releasesRoot = path.join(this.root, "knowledge", courseId, "releases");
    try {
      const entries = await (await import("node:fs/promises")).readdir(releasesRoot, { withFileTypes: true });
      const releases = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.readJson<KnowledgeRelease>(this.releaseFile(courseId, entry.name, "index/release.json"))));
      return releases.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getReleaseTree(courseId: string, releaseId: string): Promise<KnowledgeTreeEntry[]> {
    const release = await this.readJson<KnowledgeRelease>(this.releaseFile(courseId, releaseId, "index/release.json"));
    if (release.courseId !== courseId) throw new KnowledgeReleaseError("Release belongs to another course");
    return this.readJson<KnowledgeTreeEntry[]>(this.releaseFile(courseId, releaseId, "index/tree.json"));
  }

  async createRevisionDraft(courseId: string, releaseId: string): Promise<{ imported: ImportRecord; draft: DraftSummary }> {
    const tree = await this.getReleaseTree(courseId, releaseId);
    const files = await Promise.all(tree.map(async (entry) => ({
      relativePath: entry.path,
      content: await this.readReleaseContent(courseId, releaseId, entry.path),
    })));
    const created = await this.createImport(courseId, files);
    const sections = await this.getSourceSections(courseId, created.id);
    const draft = await this.renderPlan(courseId, created.id, {
      documents: tree.map((entry) => ({
        path: entry.path,
        title: entry.title,
        sectionIds: sections.filter((section) => section.sourcePath === entry.path).map((section) => section.id),
      })),
    });
    const stored = await this.readImport(created.id);
    const updated: StoredImport = { ...stored, baseReleaseId: releaseId };
    await this.writeImport(updated);
    const { sections: _sections, ...imported } = updated;
    return { imported, draft };
  }

  async activateRelease(courseId: string, releaseId: string): Promise<KnowledgeRelease> {
    const release = await this.readJson<KnowledgeRelease>(this.releaseFile(courseId, releaseId, "index/release.json"));
    if (release.courseId !== courseId) throw new KnowledgeReleaseError("Release belongs to another course");
    await this.filesystem.writeText(this.activeFile(courseId), this.stringify({ releaseId, manifestHash: release.manifestHash }));
    return release;
  }

  async readReleaseContent(courseId: string, releaseId: string, relativePath: string): Promise<string> {
    await this.readJson<KnowledgeRelease>(this.releaseFile(courseId, releaseId, "index/release.json"));
    const releaseFilesystem = new SafeFilesystem(this.releaseDirectory(courseId, releaseId));
    return releaseFilesystem.readText(relativePath);
  }

  async readDraftContent(courseId: string, importId: string, relativePath: string): Promise<string> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    const draftFilesystem = new SafeFilesystem(this.stagingDirectory(courseId, importId));
    return draftFilesystem.readText(relativePath);
  }

  private async validateDraftLinks(courseId: string, importId: string, tree: KnowledgeTreeEntry[]): Promise<void> {
    const paths = new Set(tree.map((entry) => entry.path.replaceAll("\\", "/")));
    for (const entry of tree) {
      const text = await this.readDraftContent(courseId, importId, entry.path);
      for (const target of markdownTargets(text)) {
        if (target.startsWith("#") || /^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) continue;
        const decodedTarget = decodeURIComponent(target.split("#", 1)[0] ?? "");
        if (decodedTarget.length === 0) continue;
        const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path.replaceAll("\\", "/")), decodedTarget));
        if (candidate.startsWith("../") || !paths.has(candidate)) {
          throw new KnowledgeReleaseError(`Broken Markdown link in ${entry.path}: ${target}`);
        }
      }
    }
  }

  private async calculateManifestHash(filesystem: SafeFilesystem, tree: KnowledgeTreeEntry[]): Promise<string> {
    const entries = await Promise.all(tree.map(async ({ path: targetPath, sourceSectionIds }) => ({
      path: targetPath,
      sourceSectionIds,
      contentHash: createHash("sha256").update(await filesystem.readText(targetPath)).digest("hex"),
    })));
    return hashJson(entries);
  }

  private async getCourse(courseId: string): Promise<Course> {
    return this.readJson<Course>(this.courseFile(courseId));
  }

  private async readImport(importId: string): Promise<StoredImport> {
    return this.readJson<StoredImport>(this.importFile(importId));
  }

  private async writeImport(imported: StoredImport): Promise<void> {
    await this.filesystem.writeText(this.importFile(imported.id), this.stringify(imported));
  }

  private async readJson<T>(relativePath: string): Promise<T> {
    return JSON.parse(await this.filesystem.readText(relativePath)) as T;
  }

  private courseFile(courseId: string): string {
    return `knowledge/${courseId}/course.json`;
  }

  private activeFile(courseId: string): string {
    return `knowledge/${courseId}/active.json`;
  }

  private importFile(importId: string): string {
    return `inbox/materials/${importId}/import.json`;
  }

  private sourceFile(importId: string, relativePath: string): string {
    return `inbox/materials/${importId}/source/${relativePath.replaceAll("\\", "/")}`;
  }

  private stagingDirectory(courseId: string, importId: string): string {
    return path.join(this.root, "knowledge", courseId, "staging", importId);
  }

  private stagingFile(courseId: string, importId: string, relativePath: string): string {
    return `knowledge/${courseId}/staging/${importId}/${relativePath}`;
  }

  private releaseDirectory(courseId: string, releaseId: string): string {
    return path.join(this.root, "knowledge", courseId, "releases", releaseId);
  }

  private releaseFile(courseId: string, releaseId: string, relativePath: string): string {
    return `knowledge/${courseId}/releases/${releaseId}/${relativePath}`;
  }

  private assertImportCourse(imported: ImportRecord, courseId: string): void {
    if (imported.courseId !== courseId) throw new KnowledgeReleaseError("Import belongs to another course");
  }

  private stringify(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }
}

function splitSections(sourcePath: string, content: string): SourceSection[] {
  const matches = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)];
  if (matches.length === 0) return [{ id: `${sourcePath}#0`, sourcePath, title: path.basename(sourcePath), content }];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? content.length;
    return {
      id: `${sourcePath}#${index}`,
      sourcePath,
      title: match[1]?.trim() ?? path.basename(sourcePath),
      content: content.slice(start, end),
    };
  });
}

function validatePlan(sections: SourceSection[], plan: KnowledgePlan): KnowledgeTreeEntry[] {
  if (plan.documents.length === 0) throw new KnowledgeReleaseError("Knowledge plan must contain at least one document");
  const known = new Set(sections.map((section) => section.id));
  const assigned = new Set<string>();
  const paths = new Set<string>();
  const tree: KnowledgeTreeEntry[] = [];
  for (const document of plan.documents) {
    if (!document.title.trim()) throw new KnowledgeReleaseError("Document title is required");
    const documentPath = document.path.replaceAll("\\", "/");
    if (paths.has(documentPath)) throw new KnowledgeReleaseError(`Duplicate target path: ${document.path}`);
    paths.add(documentPath);
    validateDocumentPath(documentPath);
    if (document.sectionIds.length === 0) throw new KnowledgeReleaseError(`Document ${document.path} has no source sections`);
    for (const sectionId of document.sectionIds) {
      if (!known.has(sectionId)) throw new KnowledgeReleaseError(`Unknown source section: ${sectionId}`);
      if (assigned.has(sectionId)) throw new KnowledgeReleaseError(`Source section appears more than once: ${sectionId}`);
      assigned.add(sectionId);
    }
    tree.push({ path: documentPath, type: "file", title: document.title.trim(), sourceSectionIds: [...document.sectionIds] });
  }
  for (const section of sections) {
    if (!assigned.has(section.id)) throw new KnowledgeReleaseError(`Source section is not covered: ${section.id}`);
  }
  return tree.sort((left, right) => left.path.localeCompare(right.path));
}

function markdownTargets(content: string): string[] {
  return [...content.matchAll(/!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map((match) => match[1] ?? "");
}

function validateDocumentPath(documentPath: string): void {
  const segments = documentPath.split("/");
  if (
    path.posix.isAbsolute(documentPath)
    || path.win32.isAbsolute(documentPath)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))
    || ![".md", ".markdown"].includes(path.posix.extname(documentPath).toLowerCase())
  ) {
    throw new KnowledgeReleaseError(`Invalid knowledge document path: ${documentPath}`);
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
