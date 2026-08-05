import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { PiAssignmentGrader } from "../agents/assignment-grader/agent.js";
import { sseFrame } from "./streaming/sse.js";
import type { GradingDraft, ReviewReason } from "../schemas/grading.js";
import { GradingResultService } from "../services/grading-result-service.js";
import { GradingCsvExportService } from "../services/grading-csv-export-service.js";
import {
  GradingRunService,
  type GradingAgentFactory,
} from "../services/grading-run-service.js";
import {
  GradingConflictError,
  GradingSessionService,
} from "../services/grading-session-service.js";
import type {
  MineruConversionClient,
  SubmissionConversionOptions,
} from "../services/submission-conversion-service.js";
import { SubmissionConversionService } from "../services/submission-conversion-service.js";
import { SubmissionTitleService } from "../services/submission-title-service.js";
import {
  resolveStudentIdentity,
  type StudentIdentityClient,
} from "../services/student-identity-service.js";
import type { RubricService } from "../services/rubric-service.js";

const sessionParams = z.object({ id: z.string().uuid() });
const runParams = z.object({ id: z.string().uuid(), runId: z.string().uuid() });
const editSubmissionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  markdown: z.string().max(10 * 1024 * 1024),
});
const messageSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
});
const draftSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  draft: z.unknown(),
  note: z.string().trim().max(2_000).optional(),
});
const confirmSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reviewNote: z.string().max(4_000).default(""),
  acknowledgedReasons: z.array(z.string()).default([]),
});
const sessionListSchema = z
  .object({
    assignmentId: z.string().uuid().optional(),
    rubricVersion: z.coerce.number().int().positive().optional(),
  })
  .refine(
    (value) => !value.rubricVersion || Boolean(value.assignmentId),
    "assignmentId is required with rubricVersion",
  );
const sessionTitleSchema = z.object({
  title: z.string().trim().min(1).max(80),
});
const csvExportSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("student"),
      courseId: z.string().uuid(),
      studentNumber: z.string().trim().min(1).max(80),
    }),
    z.object({
      kind: z.literal("rubric"),
      assignmentId: z.string().uuid(),
      rubricVersion: z.number().int().positive(),
    }),
  ]),
  columns: z.object({
    studentName: z.boolean().default(false),
    studentNumber: z.boolean().default(false),
    submissionTitle: z.boolean().default(false),
    itemDetails: z.boolean().default(false),
    itemConfidence: z.boolean().default(false),
    totalScore: z.boolean().default(false),
    overallConfidence: z.boolean().default(false),
  }),
});

export interface GradingApiOptions {
  workspaceRoot: string;
  rubrics: RubricService;
  identityClient?: StudentIdentityClient;
  conversionClient?: MineruConversionClient;
  conversionOptions?: SubmissionConversionOptions;
  gradingAgentFactory?: GradingAgentBuilder;
  submissionTitleAgentFactory?: GradingAgentBuilder;
}

export type GradingAgentBuilder = (
  sessionId: string,
  runId: string,
  services: {
    sessions: GradingSessionService;
    results: GradingResultService;
    rubrics: RubricService;
  },
) => PiAssignmentGrader;

export interface GradingApiControl {
  cancel(runId: string): Promise<boolean | undefined>;
  close(): void;
}

export function registerGradingApi(
  app: FastifyInstance,
  options: GradingApiOptions,
): GradingApiControl {
  const sessions = new GradingSessionService(
    options.workspaceRoot,
    options.rubrics,
  );
  const results = new GradingResultService(
    options.workspaceRoot,
    sessions,
    options.rubrics,
  );
  const csv = new GradingCsvExportService(sessions, results, options.rubrics);
  const fallback: PiAssignmentGrader = {
    async run() {
      return { kind: "reply", reply: "批改模型尚未配置。" };
    },
  };
  const runs = new GradingRunService(
    options.workspaceRoot,
    sessions,
    options.gradingAgentFactory
      ? (sessionId, runId) =>
          options.gradingAgentFactory!(sessionId, runId, {
            sessions,
            results,
            rubrics: options.rubrics,
          })
      : () => fallback,
  );
  const conversions = options.conversionClient
    ? new SubmissionConversionService(
        sessions,
        options.conversionClient,
        options.conversionOptions,
      )
    : undefined;
  const titles = options.submissionTitleAgentFactory
    ? new SubmissionTitleService(sessions, (sessionId, runId) =>
        options.submissionTitleAgentFactory!(sessionId, runId, {
          sessions,
          results,
          rubrics: options.rubrics,
        }),
      )
    : undefined;

  app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 10 },
    });

    scoped.get("/api/grading/rubrics", async () => {
      const assignments = await options.rubrics.listAssignments();
      const available = [];
      for (const assignment of assignments) {
        for (const version of await options.rubrics.listVersions(assignment.id))
          available.push({
            assignmentId: assignment.id,
            title: assignment.title,
            courseId: assignment.courseId,
            version: version.version,
            hash: version.hash,
            rubric: version.rubric,
          });
      }
      return available;
    });

    scoped.post("/api/grading/sessions", async (request, reply) => {
      const parts = request.parts();
      const fields: Record<string, string> = {};
      let upload: { filename: string; bytes: Buffer } | undefined;
      for await (const part of parts) {
        if (part.type === "file") {
          if (upload) throw new Error("Only one submission file is allowed");
          upload = { filename: part.filename, bytes: await part.toBuffer() };
        } else fields[part.fieldname] = String(part.value ?? "");
      }
      if (!upload)
        return reply
          .code(400)
          .send({
            code: "VALIDATION_ERROR",
            message: "A submission file is required",
          });
      const values = z
        .object({
          assignmentId: z.string().uuid(),
          rubricVersion: z.coerce.number().int().positive(),
          studentName: z.string().default(""),
          studentNumber: z.string().default(""),
          submissionTitle: z.string().trim().max(200).default(""),
          autoStartAfterConversion: z.enum(["true", "false"]).default("false"),
        })
        .parse(fields);
      if (!values.submissionTitle && !titles)
        return reply
          .code(503)
          .send({
            code: "SUBMISSION_TITLE_MODEL_NOT_CONFIGURED",
            message:
              "Fill in the assignment title or configure the naming model",
          });
      if (
        values.autoStartAfterConversion === "true" &&
        !options.gradingAgentFactory
      )
        return reply
          .code(503)
          .send({
            code: "GRADING_MODEL_NOT_CONFIGURED",
            message:
              "Configure the grading model before enabling automatic grading",
          });
      const identity = await resolveStudentIdentity({
        studentName: values.studentName,
        studentNumber: values.studentNumber,
        filename: upload.filename,
        ...(options.identityClient ? { client: options.identityClient } : {}),
      });
      const temp = await mkdtemp(
        path.join(os.tmpdir(), "course-agent-upload-"),
      );
      const tempPath = path.join(
        temp,
        "submission" + path.extname(upload.filename),
      );
      try {
        await writeFile(tempPath, upload.bytes);
        const session = await sessions.createSession({
          assignmentId: values.assignmentId,
          rubricVersion: values.rubricVersion,
          ...identity,
          ...(values.submissionTitle
            ? { submissionTitle: values.submissionTitle }
            : {}),
          originalPath: tempPath,
          originalFilename: upload.filename,
          autoStartAfterConversion: values.autoStartAfterConversion === "true",
        });
        if (session.conversionStatus !== "ready") {
          if (!conversions)
            return reply
              .code(503)
              .send({
                code: "MINERU_NOT_CONFIGURED",
                message: "MinerU is required for this file type",
              });
          void conversions
            .process(session.id)
            .then(() => finishReadySession(session.id))
            .catch(() => undefined);
        } else await finishReadySession(session.id);
        return reply.code(201).send(await sessions.getSession(session.id));
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    });

    scoped.get("/api/grading/sessions", async (request) => {
      const query = sessionListSchema.parse(request.query);
      return sessions.listSessions({
        ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
        ...(query.rubricVersion ? { rubricVersion: query.rubricVersion } : {}),
      });
    });

    scoped.post("/api/grading/exports/csv", async (request, reply) => {
      const body = csvExportSchema.parse(request.body);
      const content = await csv.export(body);
      return reply
        .header(
          "content-disposition",
          'attachment; filename="grading-results.csv"',
        )
        .type("text/csv; charset=utf-8")
        .send(content);
    });
    scoped.patch("/api/grading/sessions/:id", async (request) =>
      sessions.renameSession(
        sessionParams.parse(request.params).id,
        sessionTitleSchema.parse(request.body).title,
      ),
    );
    scoped.delete("/api/grading/sessions/:id", async (request, reply) => {
      await sessions.deleteSession(sessionParams.parse(request.params).id);
      return reply.code(204).send();
    });
    scoped.get("/api/grading/sessions/:id", async (request) => {
      const { id } = sessionParams.parse(request.params);
      const session = await sessions.getSession(id);
      return {
        ...session,
        submission:
          session.conversionStatus === "ready"
            ? {
                markdown: await sessions.readSubmission(id),
                locked: session.gradingStatus !== "not_started",
              }
            : null,
        draft: (await results.readDraft(id)) ?? null,
        confirmed: (await results.readConfirmedResult(id)) ?? null,
        conversation: await runs.getConversation(id),
      };
    });
    scoped.get("/api/grading/sessions/:id/assets/*", async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      const assetPath = `assets/${(request.params as { "*": string })["*"]}`;
      return reply
        .type(contentType(assetPath))
        .send(Buffer.from(await sessions.readSubmissionAsset(id, assetPath)));
    });
    scoped.put("/api/grading/sessions/:id/submission", async (request) => {
      const { id } = sessionParams.parse(request.params);
      const payload = editSubmissionSchema.parse(request.body);
      return sessions.saveSubmission(
        id,
        payload.expectedVersion,
        payload.markdown,
      );
    });
    scoped.post(
      "/api/grading/sessions/:id/revisions",
      async (request, reply) => {
        const { id } = sessionParams.parse(request.params);
        const source = await sessions.getSession(id);
        if (
          source.conversionStatus !== "ready" ||
          source.gradingStatus === "not_started"
        )
          throw new GradingConflictError(
            "A revision can only be created after grading has started",
          );
        const temp = await mkdtemp(
          path.join(os.tmpdir(), "course-agent-revision-"),
        );
        const tempPath = path.join(temp, "submission.md");
        try {
          await writeFile(tempPath, await sessions.readSubmission(id), "utf8");
          const locked = await sessions.getLockedSubmission(id);
          const revisionAssets = await Promise.all(
            (locked.assetPaths ?? []).map(async (assetPath) => ({
              path: assetPath,
              bytes: await sessions.readSubmissionAsset(id, assetPath),
            })),
          );
          const revision = await sessions.createSession({
            assignmentId: source.assignmentId,
            rubricVersion: source.rubricVersion,
            studentName: source.studentName,
            studentNumber: source.studentNumber,
            ...(source.submissionTitle
              ? { submissionTitle: source.submissionTitle }
              : {}),
            originalPath: tempPath,
            originalFilename: "submission-revision.md",
            autoStartAfterConversion: false,
            revisionAssets,
          });
          return reply.code(201).send(revision);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      },
    );
    scoped.post(
      "/api/grading/sessions/:id/conversion/retry",
      async (request, reply) => {
        const { id } = sessionParams.parse(request.params);
        if (!conversions)
          return reply
            .code(503)
            .send({
              code: "MINERU_NOT_CONFIGURED",
              message: "MinerU is not configured",
            });
        await sessions.retryConversion(id);
        void conversions
          .process(id)
          .then(() => finishReadySession(id))
          .catch(() => undefined);
        return reply.code(202).send(await sessions.getSession(id));
      },
    );
    scoped.post(
      "/api/grading/sessions/:id/title/retry",
      async (request, reply) => {
        if (!titles)
          return reply
            .code(503)
            .send({
              code: "SUBMISSION_TITLE_MODEL_NOT_CONFIGURED",
              message: "The naming model is not configured",
            });
        const { id } = sessionParams.parse(request.params);
        await titles.resolve(id);
        return sessions.getSession(id);
      },
    );
    scoped.post("/api/grading/sessions/:id/runs", async (request, reply) => {
      if (!options.gradingAgentFactory)
        return reply
          .code(503)
          .send({
            code: "GRADING_MODEL_NOT_CONFIGURED",
            message: "The grading model is not configured",
          });
      const { id } = sessionParams.parse(request.params);
      const message = z
        .object({
          message: z
            .string()
            .trim()
            .min(1)
            .max(8_000)
            .default("请开始批改当前作业。"),
        })
        .parse(request.body ?? {}).message;
      return reply.code(202).send(await startGrade(id, message));
    });
    scoped.post(
      "/api/grading/sessions/:id/messages",
      async (request, reply) => {
        if (!options.gradingAgentFactory)
          return reply
            .code(503)
            .send({
              code: "GRADING_MODEL_NOT_CONFIGURED",
              message: "The grading model is not configured",
            });
        const { id } = sessionParams.parse(request.params);
        return reply
          .code(202)
          .send(
            await runs.start(id, {
              kind: "chat",
              message: messageSchema.parse(request.body).message,
            }),
          );
      },
    );
    scoped.get(
      "/api/grading/sessions/:id/runs/:runId/events",
      async (request, reply) => {
        const { id, runId } = runParams.parse(request.params);
        const run = await runs.getRun(runId);
        if (run.sessionId !== id)
          return reply.code(404).send({ code: "RUN_NOT_FOUND" });
        const query = z
          .object({
            after: z.coerce.number().int().nonnegative().default(0),
            follow: z.enum(["true", "false"]).default("true"),
          })
          .parse(request.query);
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let after = query.after;
        while (true) {
          for (const event of await runs.listEvents(runId, after)) {
            after = event.sequence;
            reply.raw.write(
              `id: ${event.sequence}\n${sseFrame(event.type, event)}`,
            );
          }
          const current = await runs.getRun(runId);
          if (
            query.follow === "false" ||
            [
              "completed",
              "waiting_for_teacher",
              "failed",
              "cancelled",
            ].includes(current.status) ||
            request.raw.destroyed
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        reply.raw.end();
        return reply;
      },
    );
    scoped.put("/api/grading/sessions/:id/draft", async (request) => {
      const { id } = sessionParams.parse(request.params);
      const payload = draftSchema.parse(request.body);
      return results.submitDraft(
        id,
        payload.expectedVersion,
        payload.draft as GradingDraft,
        {
          type: "teacher",
          id: "local-teacher",
          ...(payload.note ? { note: payload.note } : {}),
        },
      );
    });
    scoped.post("/api/grading/sessions/:id/validate", async (request) => {
      const { id } = sessionParams.parse(request.params);
      const draft = await results.readDraft(id);
      return { valid: Boolean(draft), draft: draft ?? null };
    });
    scoped.post("/api/grading/sessions/:id/confirm", async (request) => {
      const { id } = sessionParams.parse(request.params);
      const payload = confirmSchema.parse(request.body);
      return results.confirm(id, {
        expectedVersion: payload.expectedVersion,
        reviewNote: payload.reviewNote,
        acknowledgedReasons: payload.acknowledgedReasons as ReviewReason[],
      });
    });
    scoped.get(
      "/api/grading/sessions/:id/export.json",
      async (request, reply) =>
        exportResult(
          results,
          sessionParams.parse(request.params).id,
          "json",
          reply,
        ),
    );
    scoped.get("/api/grading/sessions/:id/export.md", async (request, reply) =>
      exportResult(
        results,
        sessionParams.parse(request.params).id,
        "md",
        reply,
      ),
    );
  });

  async function startGrade(
    sessionId: string,
    message = "请开始批改当前作业。",
  ): Promise<Awaited<ReturnType<GradingRunService["start"]>>> {
    const session = await sessions.getSession(sessionId);
    if (
      !session.submissionTitle ||
      !["provided", "resolved"].includes(session.submissionTitleStatus)
    )
      throw new GradingConflictError(
        "Submission title must be resolved before grading starts",
      );
    await sessions.lockSubmissionForGrading(sessionId);
    return runs.start(sessionId, { kind: "grade", message });
  }

  async function finishReadySession(sessionId: string): Promise<void> {
    let session = await sessions.getSession(sessionId);
    if (session.conversionStatus !== "ready") return;
    if (
      session.submissionTitleStatus === "pending" ||
      session.submissionTitleStatus === "resolving" ||
      session.submissionTitleStatus === "failed"
    ) {
      if (!titles) return;
      try {
        session = await titles.resolve(sessionId);
      } catch {
        return;
      }
    }
    if (session.autoStartAfterConversion && options.gradingAgentFactory)
      await startGrade(session.id);
  }

  if (conversions) {
    void sessions
      .listPendingConversions()
      .then((pending) =>
        Promise.all(
          pending.map((session) =>
            conversions
              .process(session.id)
              .then(() => finishReadySession(session.id))
              .catch(() => undefined),
          ),
        ),
      )
      .catch(() => undefined);
  }
  if (titles) {
    void (async () => {
      const all = await sessions.listSessions();
      const pending = all.filter(
        (session) =>
          session.conversionStatus === "ready" &&
          session.submissionTitleStatus === "pending",
      );
      for (const session of pending) await finishReadySession(session.id);
    })().catch(() => undefined);
  }

  return {
    async cancel(runId) {
      try {
        return await runs.cancel(runId);
      } catch {
        return undefined;
      }
    },
    close() {
      runs.close();
      sessions.close();
    },
  };
}

async function exportResult(
  results: GradingResultService,
  sessionId: string,
  format: "json" | "md",
  reply: FastifyReply,
) {
  const confirmed = await results.readConfirmedResult(sessionId);
  if (!confirmed)
    return reply
      .code(409)
      .send({
        code: "RESULT_NOT_CONFIRMED",
        message: "Only confirmed results can be exported",
      });
  if (format === "json")
    return reply.type("application/json; charset=utf-8").send(confirmed);
  return reply
    .type("text/markdown; charset=utf-8")
    .send(await results.readConfirmedMarkdown(sessionId));
}

function contentType(assetPath: string): string {
  const extension = path.extname(assetPath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}
