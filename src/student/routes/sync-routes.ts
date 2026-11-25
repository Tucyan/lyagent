import type { FastifyInstance } from "fastify";
import { AccountAdminService } from "../services/account-admin-service.js";
import { KnowledgeSyncError, KnowledgeSyncService } from "../services/knowledge-sync-service.js";

export function registerStudentSyncRoutes(
  app: FastifyInstance,
  deps: {
    accounts: AccountAdminService;
    syncService: KnowledgeSyncService;
  },
): void {
  // Accept application/zip or application/octet-stream as raw Buffer
  app.addContentTypeParser(["application/zip", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 105 * 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { courseId: string } }>("/api/sync/courses/:courseId/releases", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    if (!deps.accounts.verifySyncToken(token)) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "同步令牌无效或已撤销" });
    }

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(400).send({ code: "INVALID_BUNDLE", message: "请求体必须为 ZIP 二进制流" });
    }

    const expectedSha256 = typeof request.headers["x-bundle-sha256"] === "string"
      ? request.headers["x-bundle-sha256"]
      : undefined;

    try {
      const result = await deps.syncService.importReleaseBundle({
        courseId: request.params.courseId,
        bundleBytes: body,
        ...(expectedSha256 ? { expectedSha256 } : {}),
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof KnowledgeSyncError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });
}
