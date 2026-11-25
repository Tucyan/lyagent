import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SafeFilesystem } from "../../core/safe-filesystem.js";
import { KnowledgeAccessError, KnowledgeService } from "../../services/knowledge-service.js";
import { MaterialService } from "../../services/material-service.js";
import { AccountAdminService } from "../services/account-admin-service.js";
import type { AuthenticatedUser } from "../services/auth-service.js";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const courseIdSchema = z.string().uuid();
const docQuerySchema = z.object({
  path: z.string().min(1).max(240),
  releaseId: z.string().uuid().optional(),
});
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  offset: z.coerce.number().int().min(0).max(500).default(0),
  maxResults: z.coerce.number().int().min(1).max(10).default(10),
});

export function registerStudentKnowledgeRoutes(
  app: FastifyInstance,
  deps: {
    workspaceRoot: string;
    accounts: AccountAdminService;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedUser | undefined>;
    requireCourseAccess: (request: FastifyRequest, reply: FastifyReply, courseId: string) => Promise<AuthenticatedUser | undefined>;
  },
): void {
  const materials = new MaterialService(deps.workspaceRoot);
  const knowledge = new KnowledgeService(deps.workspaceRoot);
  const filesystem = new SafeFilesystem(deps.workspaceRoot);

  app.get("/api/student/courses", async (request, reply) => {
    const user = await deps.requireAuth(request, reply);
    if (!user) return;

    const allCourses = await materials.listCourses();
    const allowedIds = user.role === "teacher" ? null : new Set(deps.accounts.listAuthorizedCourseIds(user.id));

    const visibleCourses: Array<{ id: string; name: string; activeReleaseId: string; releasedAt: string }> = [];
    for (const course of allCourses) {
      if (allowedIds && !allowedIds.has(course.id)) continue;
      try {
        const snapshot = await materials.getActiveReleaseSnapshot(course.id);
        if (!snapshot) continue;
        visibleCourses.push({
          id: course.id,
          name: course.name,
          activeReleaseId: snapshot.release.id,
          releasedAt: snapshot.release.createdAt,
        });
      } catch {
        // Unavailable or damaged release is excluded from student view
      }
    }
    return { courses: visibleCourses };
  });

  app.get<{ Params: { courseId: string } }>("/api/student/courses/:courseId/tree", async (request, reply) => {
    const courseId = courseIdSchema.parse(request.params.courseId);
    const user = await deps.requireCourseAccess(request, reply, courseId);
    if (!user) return;

    const course = (await materials.listCourses()).find((item) => item.id === courseId);
    if (!course) return reply.code(404).send({ code: "COURSE_NOT_FOUND", message: "课程不存在" });
    const courseKnowledge = await knowledge.forCourse(courseId);
    return {
      course: { id: course.id, name: course.name },
      release: courseKnowledge.release,
      documents: courseKnowledge.documents,
    };
  });

  app.get<{ Params: { courseId: string }; Querystring: { path?: string; releaseId?: string } }>(
    "/api/student/courses/:courseId/document",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;

      const query = docQuerySchema.parse(request.query);
      const courseKnowledge = await knowledge.forCourse(courseId);
      if (query.releaseId && query.releaseId !== courseKnowledge.release.id) {
        return reply.code(409).send({
          code: "RELEASE_CHANGED",
          message: "课程资料已更新，请刷新页面后重新查看",
          activeReleaseId: courseKnowledge.release.id,
        });
      }

      try {
        const range = await courseKnowledge.readLines(query.path, 1, 100_000);
        return {
          releaseId: courseKnowledge.release.id,
          path: query.path,
          content: range.content,
        };
      } catch (error) {
        if (error instanceof KnowledgeAccessError) {
          return reply.code(error.code === "KNOWLEDGE_DOCUMENT_NOT_FOUND" ? 404 : 422).send({
            code: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { courseId: string }; Querystring: { q?: string; offset?: string; maxResults?: string } }>(
    "/api/student/courses/:courseId/search",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;

      const query = searchQuerySchema.parse(request.query);
      const courseKnowledge = await knowledge.forCourse(courseId);
      const results = await courseKnowledge.search(query.q, query.offset, query.maxResults);
      return { releaseId: courseKnowledge.release.id, results };
    },
  );

  app.get<{ Params: { courseId: string; releaseId: string; "*": string } }>(
    "/api/student/courses/:courseId/releases/:releaseId/assets/*",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const releaseId = courseIdSchema.parse(request.params.releaseId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;

      const courseKnowledge = await knowledge.forCourse(courseId);
      if (courseKnowledge.release.id !== releaseId) {
        return reply.code(409).send({ code: "RELEASE_CHANGED", message: "课程资料版本已更新" });
      }

      const rawRelative = request.params["*"] ?? "";
      const normalized = rawRelative.replaceAll("\\", "/").replace(/^\/+/u, "");
      if (!normalized || normalized.includes("..") || normalized.includes(":")) {
        return reply.code(400).send({ code: "INVALID_ASSET_PATH", message: "非法的资源路径" });
      }
      const ext = path.posix.extname(normalized).toLowerCase();
      const contentType = ASSET_CONTENT_TYPES[ext];
      if (!contentType) {
        return reply.code(403).send({ code: "UNSUPPORTED_ASSET", message: "不支持的资源类型" });
      }

      try {
        const bytes = await filesystem.readBytes(`knowledge/${courseId}/releases/${releaseId}/${normalized}`);
        return reply.type(contentType).send(bytes);
      } catch {
        return reply.code(404).send({ code: "ASSET_NOT_FOUND", message: "资源不存在" });
      }
    },
  );
}
