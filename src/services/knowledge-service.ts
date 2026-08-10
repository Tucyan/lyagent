import { ZodError } from "zod";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import { knowledgePathSchema, lineRangeSchema, paginationSchema, searchQuerySchema, type KnowledgeDocument, type KnowledgeLineRange, type KnowledgeSearchResult } from "../schemas/knowledge.js";
import { MaterialService, type KnowledgeRelease, type KnowledgeTreeEntry } from "./material-service.js";

export class KnowledgeAccessError extends Error {
  constructor(public readonly code: "ACTIVE_RELEASE_NOT_FOUND" | "INVALID_KNOWLEDGE_REQUEST" | "KNOWLEDGE_DOCUMENT_NOT_FOUND", message: string) {
    super(message);
    this.name = "KnowledgeAccessError";
  }
}

interface ActiveKnowledgeContext {
  release: KnowledgeRelease;
  documents: KnowledgeDocument[];
  filesystem: SafeFilesystem;
}

export class KnowledgeService {
  private readonly materials: MaterialService;

  constructor(workspaceRoot: string) {
    this.materials = new MaterialService(workspaceRoot);
  }

  async forCourse(courseId: string): Promise<CourseKnowledgeService> {
    let release: KnowledgeRelease | undefined;
    try { release = await this.materials.getActiveRelease(courseId); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new KnowledgeAccessError("ACTIVE_RELEASE_NOT_FOUND", "This course has no active knowledge release");
      throw error;
    }
    if (!release) throw new KnowledgeAccessError("ACTIVE_RELEASE_NOT_FOUND", "This course has no active knowledge release");
    const releaseRoot = `knowledge/${courseId}/releases/${release.id}`;
    const filesystem = new SafeFilesystem(`${this.materials.root}/${releaseRoot}`);
    let tree: KnowledgeTreeEntry[];
    try {
      tree = JSON.parse(await filesystem.readText("index/tree.json")) as KnowledgeTreeEntry[];
    } catch {
      throw new KnowledgeAccessError("ACTIVE_RELEASE_NOT_FOUND", "The active knowledge release is unavailable");
    }
    const documents = tree
      .filter((entry) => entry.type === "file")
      .map(({ path, title }) => ({ path, title }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return new CourseKnowledgeService(release, documents, filesystem);
  }
}

export class CourseKnowledgeService {
  private readonly documentsByPath: Map<string, KnowledgeDocument>;

  constructor(public readonly release: KnowledgeRelease, documents: KnowledgeDocument[], private readonly filesystem: SafeFilesystem) {
    this.documentsByPath = new Map(documents.map((document) => [document.path, document]));
  }

  get documents(): KnowledgeDocument[] {
    return [...this.documentsByPath.values()];
  }

  async listDirectory(directory: string): Promise<Array<KnowledgeDocument & { type: "file" }>> {
    const normalized = this.parsePath(directory);
    const prefix = normalized ? `${normalized}/` : "";
    return [...this.documentsByPath.values()]
      .filter((document) => document.path.startsWith(prefix))
      .map((document) => ({ ...document, type: "file" as const }));
  }

  async search(query: string, offset = 0, maxResults = 10): Promise<KnowledgeSearchResult[]> {
    const normalizedQuery = this.parse(searchQuerySchema, query).toLocaleLowerCase();
    const page = this.parse(paginationSchema, { offset, maxResults });
    const results: KnowledgeSearchResult[] = [];
    for (const document of this.documentsByPath.values()) {
      const content = await this.readDocument(document.path);
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (`${document.path}\n${document.title}\n${line}`.toLocaleLowerCase().includes(normalizedQuery)) {
          results.push({ path: document.path, title: document.title, startLine: index + 1, endLine: index + 1, excerpt: line.slice(0, 300) });
        }
      }
    }
    return results.slice(page.offset, page.offset + page.maxResults);
  }

  async readLines(documentPath: string, startLine: number, endLine: number): Promise<KnowledgeLineRange> {
    const normalizedPath = this.parsePath(documentPath);
    if (!this.documentsByPath.has(normalizedPath)) throw new KnowledgeAccessError("KNOWLEDGE_DOCUMENT_NOT_FOUND", "Knowledge document was not found");
    const requested = this.parse(lineRangeSchema, { startLine, endLine });
    const lines = (await this.readDocument(normalizedPath)).split(/\r?\n/);
    const actualEndLine = Math.min(requested.endLine, Math.max(1, lines.length));
    if (requested.startLine > actualEndLine) throw new KnowledgeAccessError("INVALID_KNOWLEDGE_REQUEST", "Requested lines are outside the document");
    return {
      path: normalizedPath,
      startLine: requested.startLine,
      endLine: actualEndLine,
      content: `${lines.slice(requested.startLine - 1, actualEndLine).join("\n")}\n`,
    };
  }

  private async readDocument(documentPath: string): Promise<string> {
    try {
      return await this.filesystem.readText(documentPath);
    } catch {
      throw new KnowledgeAccessError("KNOWLEDGE_DOCUMENT_NOT_FOUND", "Knowledge document was not found");
    }
  }

  private parsePath(value: string): string {
    return this.parse(knowledgePathSchema, value);
  }

  private parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
    try {
      return schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) throw new KnowledgeAccessError("INVALID_KNOWLEDGE_REQUEST", "Invalid knowledge request");
      throw error;
    }
  }
}
