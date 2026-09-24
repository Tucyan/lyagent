import { createHash, randomUUID } from "node:crypto";
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
  treeHash?: string;
  createdAt: string;
}

export interface ActiveKnowledgeReleaseSnapshot {
  release: KnowledgeRelease;
  tree: KnowledgeTreeEntry[];
  contentHashes: ReadonlyMap<string, string>;
}

interface ContentManifestEntry {
  path: string;
  sourceSectionIds: string[];
  contentHash: string;
}

interface StoredReleaseManifest {
  manifestHash?: string;
  manifestIndexHash?: string;
  contentManifestHash?: string;
  treeHash?: string;
  files?: string[];
  entries?: ContentManifestEntry[];
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
  private readonly verifiedLegacyContentHashes = new Map<string, ReadonlyMap<string, string>>();

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
    try {
      const entries = await this.filesystem.listDirectories("knowledge");
      const courses = await Promise.all(entries.map(async (courseId) => this.getCourse(courseId)));
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
    try {
      const entries = await this.filesystem.listDirectories("inbox/materials");
      const drafts = await Promise.all(entries.map(async (importId) => this.readImport(importId)));
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
    const staging = this.stagingRelativeDirectory(courseId, importId);
    const temporary = `${staging}.tmp-${randomUUID()}`;
    if (await this.filesystem.directoryExists(temporary)) await this.filesystem.removeDirectory(temporary);
    await this.filesystem.ensureDirectory(temporary);
    for (const [index, document] of plan.documents.entries()) {
      const content = documentContents?.[index]
        ?? document.sectionIds.map((id) => imported.sections.find((section) => section.id === id)?.content ?? "").join("\n");
      await this.filesystem.writeText(`${temporary}/${document.path}`, content);
    }
    const contentEntries = await this.calculateManifestEntries(temporary, tree);
    const manifestHash = hashJson(contentEntries);
    const draft: StoredDraft = { version: nextVersion, manifestHash, tree, plan };
    await this.filesystem.writeText(`${temporary}/index/tree.json`, this.stringify(tree));
    await this.filesystem.writeText(`${temporary}/index/manifest.json`, this.stringify({ manifestHash, files: tree.map((entry) => entry.path), entries: contentEntries }));
    await this.filesystem.writeText(`${temporary}/index/draft.json`, this.stringify(draft));
    if (await this.filesystem.directoryExists(staging)) await this.filesystem.removeDirectory(staging);
    await this.filesystem.moveDirectory(temporary, staging);

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

    const staging = this.stagingRelativeDirectory(courseId, importId);
    await this.filesystem.writeText(`${staging}/${relativePath}`, content);
    const nextVersion = draft.version + 1;
    const contentEntries = await this.calculateManifestEntries(staging, draft.tree);
    const manifestHash = hashJson(contentEntries);
    const updatedDraft: StoredDraft = { ...draft, version: nextVersion, manifestHash };
    await this.filesystem.writeText(`${staging}/index/manifest.json`, this.stringify({ manifestHash, files: draft.tree.map((entry) => entry.path), entries: contentEntries }));
    await this.filesystem.writeText(`${staging}/index/draft.json`, this.stringify(updatedDraft));
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
    const staging = this.stagingRelativeDirectory(courseId, importId);
    const draftManifest = await this.readJson<StoredReleaseManifest>(this.stagingFile(courseId, importId, "index/manifest.json"));
    const contentEntries = isContentManifest(draftManifest.entries, draft.tree)
      ? draftManifest.entries
      : await this.calculateManifestEntries(staging, draft.tree);
    if (hashJson(contentEntries) !== draft.manifestHash)
      throw new KnowledgeReleaseError("Draft content manifest does not match its content");
    const treeHash = hashJson(draft.tree);
    const files = draft.tree.map(({ path: targetPath }) => targetPath);
    const manifestIndex = { contentManifestHash: draft.manifestHash, treeHash, files, entries: contentEntries };
    const manifestIndexHash = hashJson(manifestIndex);
    const release: KnowledgeRelease = {
      id: randomUUID(),
      courseId,
      importId,
      manifestHash: hashJson({ manifestIndexHash, treeHash }),
      treeHash,
      createdAt: new Date().toISOString(),
    };
    const releaseDirectory = this.releaseRelativeDirectory(courseId, release.id);
    await this.filesystem.moveDirectory(staging, releaseDirectory);
    await this.filesystem.writeText(this.releaseFile(courseId, release.id, "index/release.json"), this.stringify(release));
    await this.filesystem.writeText(this.releaseFile(courseId, release.id, "index/manifest.json"), this.stringify({
      manifestHash: release.manifestHash,
      ...manifestIndex,
      manifestIndexHash,
    }));
    await this.filesystem.writeText(this.activeFile(courseId), this.stringify({ releaseId: release.id, manifestHash: release.manifestHash }));
    await this.writeImport({ ...imported, status: "published", updatedAt: new Date().toISOString() });
    return release;
  }

  async getActiveRelease(courseId: string): Promise<KnowledgeRelease | undefined> {
    return (await this.getActiveReleaseSnapshot(courseId))?.release;
  }

  async getActiveReleaseSnapshot(courseId: string): Promise<ActiveKnowledgeReleaseSnapshot | undefined> {
    await this.getCourse(courseId);
    try {
      const active = await this.readJson<{ releaseId: string; manifestHash: string }>(this.activeFile(courseId));
      const release = await this.readJson<KnowledgeRelease>(this.releaseFile(courseId, active.releaseId, "index/release.json"));
      if (release.courseId !== courseId || release.id !== active.releaseId || release.manifestHash !== active.manifestHash)
        throw new KnowledgeReleaseError("Active knowledge release pointer does not match release metadata");
      const integrity = await this.verifyReleaseIntegrity(courseId, release);
      return { release, ...integrity };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listReleases(courseId: string): Promise<KnowledgeRelease[]> {
    try {
      const entries = await this.filesystem.listDirectories(`knowledge/${courseId}/releases`);
      const releases = await Promise.all(entries.map((releaseId) => this.readJson<KnowledgeRelease>(this.releaseFile(courseId, releaseId, "index/release.json"))));
      return releases.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getReleaseTree(courseId: string, releaseId: string): Promise<KnowledgeTreeEntry[]> {
    const release = await this.readJson<KnowledgeRelease>(this.releaseFile(courseId, releaseId, "index/release.json"));
    if (release.courseId !== courseId) throw new KnowledgeReleaseError("Release belongs to another course");
    return (await this.verifyReleaseIntegrity(courseId, release)).tree;
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
    await this.verifyReleaseIntegrity(courseId, release);
    await this.filesystem.writeText(this.activeFile(courseId), this.stringify({ releaseId, manifestHash: release.manifestHash }));
    return release;
  }

  async readReleaseContent(courseId: string, releaseId: string, relativePath: string): Promise<string> {
    const release = await this.readJson<KnowledgeRelease>(this.releaseFile(courseId, releaseId, "index/release.json"));
    if (release.courseId !== courseId) throw new KnowledgeReleaseError("Release belongs to another course");
    const integrity = await this.verifyReleaseIntegrity(courseId, release);
    if (!integrity.tree.some(({ path: targetPath }) => targetPath === relativePath))
      throw new KnowledgeReleaseError("Requested document is not part of the release");
    const content = await this.filesystem.readText(this.releaseFile(courseId, releaseId, relativePath));
    if (hashText(content) !== integrity.contentHashes.get(relativePath))
      throw new KnowledgeReleaseError("Knowledge release document integrity validation failed");
    return content;
  }

  private async verifyReleaseIntegrity(courseId: string, release: KnowledgeRelease): Promise<Pick<ActiveKnowledgeReleaseSnapshot, "tree" | "contentHashes">> {
    let tree: KnowledgeTreeEntry[];
    try {
      tree = await this.readJson<KnowledgeTreeEntry[]>(this.releaseFile(courseId, release.id, "index/tree.json"));
      if (!Array.isArray(tree) || tree.some((entry) => !entry || typeof entry.path !== "string" || entry.type !== "file"
        || typeof entry.title !== "string" || !Array.isArray(entry.sourceSectionIds)))
        throw new Error("Invalid release tree");
      const treeHash = hashJson(tree);
      if (release.treeHash && treeHash !== release.treeHash)
        throw new Error("Release tree hash does not match its metadata");
      if (!release.treeHash) {
        // Older releases predate treeHash; publish kept the original draft as a second tree record.
        const draft = await this.readJson<StoredDraft>(this.releaseFile(courseId, release.id, "index/draft.json"));
        if (draft.manifestHash !== release.manifestHash || hashJson(draft.tree) !== treeHash)
          throw new Error("Legacy release tree does not match its preserved draft");
      }
      const manifest = await this.readJson<StoredReleaseManifest>(this.releaseFile(courseId, release.id, "index/manifest.json"));
      let entries: ContentManifestEntry[];
      if (manifest.manifestIndexHash !== undefined || manifest.entries !== undefined) {
        if (!isContentManifest(manifest.entries, tree)) throw new Error("Release manifest entries are invalid");
        if (!sameKeys(manifest, ["manifestHash", "contentManifestHash", "treeHash", "files", "entries", "manifestIndexHash"]))
          throw new Error("Release manifest index has unexpected fields");
        entries = manifest.entries;
        const contentManifestHash = hashJson(entries);
        if (manifest.manifestHash !== release.manifestHash || manifest.contentManifestHash !== contentManifestHash || manifest.treeHash !== treeHash ||
          !samePaths(manifest.files, tree.map(({ path: targetPath }) => targetPath)))
          throw new Error("Release manifest index does not match its contents");
        const manifestIndex = { contentManifestHash, treeHash, files: manifest.files, entries };
        const manifestIndexHash = hashJson(manifestIndex);
        if (manifest.manifestIndexHash !== manifestIndexHash ||
          hashJson({ manifestIndexHash, treeHash }) !== release.manifestHash)
          throw new Error("Release manifest hash does not match its metadata");
      } else {
        // Older releases have no per-file hash index. Verify the whole body set
        // once per persistent MaterialService instance, then every caller still
        // hashes the selected body immediately before use.
        const cacheKey = `${courseId}:${release.id}:${release.manifestHash}`;
        const cachedHashes = this.verifiedLegacyContentHashes.get(cacheKey);
        const cacheUsable = Boolean(cachedHashes && cachedHashes.size === tree.length && tree.every(({ path: targetPath }) => cachedHashes.has(targetPath)));
        if (cacheUsable && cachedHashes) {
          entries = tree.map(({ path: targetPath, sourceSectionIds }) => ({
            path: targetPath,
            sourceSectionIds: [...sourceSectionIds],
            contentHash: cachedHashes.get(targetPath)!,
          }));
        } else {
          entries = await this.calculateManifestEntries(this.releaseRelativeDirectory(courseId, release.id), tree);
        }
        const contentManifestHash = hashJson(entries);
        if ((manifest.contentManifestHash && manifest.contentManifestHash !== contentManifestHash) ||
          (manifest.manifestHash && manifest.manifestHash !== release.manifestHash) ||
          (manifest.files && !samePaths(manifest.files, tree.map(({ path: targetPath }) => targetPath))))
          throw new Error("Release content hash does not match its manifest");
        const manifestHash = release.treeHash
          ? hashJson({ contentManifestHash, treeHash })
          : contentManifestHash;
        if (manifestHash !== release.manifestHash)
          throw new Error("Release content hash does not match its metadata");
        if (!cacheUsable) this.verifiedLegacyContentHashes.set(cacheKey, new Map(entries.map(({ path: targetPath, contentHash }) => [targetPath, contentHash])));
      }
      return { tree, contentHashes: new Map(entries.map(({ path: targetPath, contentHash }) => [targetPath, contentHash])) };
    } catch (error: unknown) {
      if (error instanceof KnowledgeReleaseError) throw error;
      throw new KnowledgeReleaseError("Knowledge release integrity validation failed");
    }
  }

  async readDraftContent(courseId: string, importId: string, relativePath: string): Promise<string> {
    const imported = await this.readImport(importId);
    this.assertImportCourse(imported, courseId);
    return this.filesystem.readText(this.stagingFile(courseId, importId, relativePath));
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

  private async calculateManifestEntries(rootRelativePath: string, tree: KnowledgeTreeEntry[]): Promise<ContentManifestEntry[]> {
    return Promise.all(tree.map(async ({ path: targetPath, sourceSectionIds }) => ({
      path: targetPath,
      sourceSectionIds: [...sourceSectionIds],
      contentHash: hashText(await this.filesystem.readText(`${rootRelativePath}/${targetPath}`)),
    })));
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

  private stagingRelativeDirectory(courseId: string, importId: string): string {
    return `knowledge/${courseId}/staging/${importId}`;
  }

  private stagingFile(courseId: string, importId: string, relativePath: string): string {
    return `knowledge/${courseId}/staging/${importId}/${relativePath}`;
  }

  private releaseRelativeDirectory(courseId: string, releaseId: string): string {
    return `knowledge/${courseId}/releases/${releaseId}`;
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

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContentManifest(value: unknown, tree: KnowledgeTreeEntry[]): value is ContentManifestEntry[] {
  return Array.isArray(value) && value.length === tree.length && value.every((entry, index) => {
    const treeEntry = tree[index];
    return Boolean(treeEntry && entry && typeof entry === "object"
      && (entry as ContentManifestEntry).path === treeEntry.path
      && JSON.stringify((entry as ContentManifestEntry).sourceSectionIds) === JSON.stringify(treeEntry.sourceSectionIds)
      && /^[0-9a-f]{64}$/i.test((entry as ContentManifestEntry).contentHash));
  });
}

function samePaths(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function sameKeys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
