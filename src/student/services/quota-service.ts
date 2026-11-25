import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { formatDayKey } from "../config.js";

export interface GlobalQuotaSettings {
  emergencyQaPaused: boolean;
  globalDailyQaLimit: number | null;
  globalDailyTokenLimit: number | null;
  updatedAt: string;
}

export interface CourseQuotaPolicy {
  courseId: string;
  dailyQaLimit: number;
  totalQaLimit: number | null;
  perMinuteLimit: number;
  maxConcurrent: number;
  updatedAt: string;
}

export interface StudentQuotaOverride {
  userId: string;
  courseId: string;
  dailyQaLimit: number | null;
  totalQaLimit: number | null;
  note: string;
  updatedAt: string;
}

export interface StudentQuotaSummary {
  courseId: string;
  dayKey: string;
  emergencyQaPaused: boolean;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  totalLimit: number | null;
  totalUsed: number;
  totalRemaining: number | null;
  perMinuteLimit: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type QuotaErrorCode =
  | "QA_PAUSED"
  | "CONCURRENT_LIMIT"
  | "RATE_LIMITED"
  | "GLOBAL_DAILY_LIMIT"
  | "GLOBAL_TOKEN_LIMIT"
  | "DAILY_QUOTA_EXCEEDED"
  | "TOTAL_QUOTA_EXCEEDED";

export class QuotaExceededError extends Error {
  constructor(
    public readonly code: QuotaErrorCode,
    message: string,
    public readonly statusCode = 429,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class QuotaService {
  constructor(
    private readonly db: Database.Database,
    private readonly options: {
      timeZone?: string;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private timeZone(): string {
    return this.options.timeZone ?? "Asia/Shanghai";
  }

  getGlobalSettings(): GlobalQuotaSettings {
    const row = this.db.prepare(`
      SELECT emergency_qa_paused, global_daily_qa_limit, global_daily_token_limit, updated_at
      FROM global_quota_settings WHERE id = 1
    `).get() as {
      emergency_qa_paused: number;
      global_daily_qa_limit: number | null;
      global_daily_token_limit: number | null;
      updated_at: string;
    };
    return {
      emergencyQaPaused: row.emergency_qa_paused === 1,
      globalDailyQaLimit: row.global_daily_qa_limit,
      globalDailyTokenLimit: row.global_daily_token_limit,
      updatedAt: row.updated_at,
    };
  }

  updateGlobalSettings(input: {
    emergencyQaPaused?: boolean;
    globalDailyQaLimit?: number | null;
    globalDailyTokenLimit?: number | null;
  }): GlobalQuotaSettings {
    const current = this.getGlobalSettings();
    const nowIso = this.now().toISOString();
    const nextPaused = input.emergencyQaPaused !== undefined ? input.emergencyQaPaused : current.emergencyQaPaused;
    const nextDailyQa = input.globalDailyQaLimit !== undefined ? input.globalDailyQaLimit : current.globalDailyQaLimit;
    const nextDailyToken = input.globalDailyTokenLimit !== undefined ? input.globalDailyTokenLimit : current.globalDailyTokenLimit;

    this.db.prepare(`
      UPDATE global_quota_settings
      SET emergency_qa_paused = ?, global_daily_qa_limit = ?, global_daily_token_limit = ?, updated_at = ?
      WHERE id = 1
    `).run(nextPaused ? 1 : 0, nextDailyQa, nextDailyToken, nowIso);
    return this.getGlobalSettings();
  }

  getCoursePolicy(courseId: string): CourseQuotaPolicy {
    const row = this.db.prepare(`
      SELECT course_id, daily_qa_limit, total_qa_limit, per_minute_limit, max_concurrent, updated_at
      FROM course_quota_policies WHERE course_id = ?
    `).get(courseId) as {
      course_id: string;
      daily_qa_limit: number;
      total_qa_limit: number | null;
      per_minute_limit: number;
      max_concurrent: number;
      updated_at: string;
    } | undefined;

    if (!row) {
      return {
        courseId,
        dailyQaLimit: 20,
        totalQaLimit: null,
        perMinuteLimit: 3,
        maxConcurrent: 1,
        updatedAt: this.now().toISOString(),
      };
    }

    return {
      courseId: row.course_id,
      dailyQaLimit: row.daily_qa_limit,
      totalQaLimit: row.total_qa_limit,
      perMinuteLimit: row.per_minute_limit,
      maxConcurrent: row.max_concurrent,
      updatedAt: row.updated_at,
    };
  }

  updateCoursePolicy(
    courseId: string,
    input: {
      dailyQaLimit: number;
      totalQaLimit: number | null;
      perMinuteLimit: number;
      maxConcurrent: number;
    },
  ): CourseQuotaPolicy {
    const nowIso = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO course_quota_policies (course_id, daily_qa_limit, total_qa_limit, per_minute_limit, max_concurrent, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(course_id) DO UPDATE SET
        daily_qa_limit = excluded.daily_qa_limit,
        total_qa_limit = excluded.total_qa_limit,
        per_minute_limit = excluded.per_minute_limit,
        max_concurrent = excluded.max_concurrent,
        updated_at = excluded.updated_at
    `).run(courseId, input.dailyQaLimit, input.totalQaLimit, input.perMinuteLimit, input.maxConcurrent, nowIso);
    return this.getCoursePolicy(courseId);
  }

  upsertStudentOverride(input: {
    userId: string;
    courseId: string;
    dailyQaLimit: number | null;
    totalQaLimit: number | null;
    note?: string;
  }): StudentQuotaOverride | null {
    if (input.dailyQaLimit === null && input.totalQaLimit === null && !input.note?.trim()) {
      this.db.prepare("DELETE FROM student_quota_overrides WHERE user_id = ? AND course_id = ?").run(input.userId, input.courseId);
      return null;
    }
    const nowIso = this.now().toISOString();
    const note = input.note?.trim() ?? "";
    this.db.prepare(`
      INSERT INTO student_quota_overrides (user_id, course_id, daily_qa_limit, total_qa_limit, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, course_id) DO UPDATE SET
        daily_qa_limit = excluded.daily_qa_limit,
        total_qa_limit = excluded.total_qa_limit,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run(input.userId, input.courseId, input.dailyQaLimit, input.totalQaLimit, note, nowIso);
    return {
      userId: input.userId,
      courseId: input.courseId,
      dailyQaLimit: input.dailyQaLimit,
      totalQaLimit: input.totalQaLimit,
      note,
      updatedAt: nowIso,
    };
  }

  getStudentQuotaSummary(userId: string, courseId: string): StudentQuotaSummary {
    const now = this.now();
    const dayKey = formatDayKey(now, this.timeZone());
    const globalSettings = this.getGlobalSettings();
    const policy = this.getCoursePolicy(courseId);
    const override = this.db.prepare(`
      SELECT daily_qa_limit, total_qa_limit FROM student_quota_overrides WHERE user_id = ? AND course_id = ?
    `).get(userId, courseId) as { daily_qa_limit: number | null; total_qa_limit: number | null } | undefined;

    const dailyLimit = override?.daily_qa_limit ?? policy.dailyQaLimit;
    const totalLimit = override?.total_qa_limit ?? policy.totalQaLimit;

    const dailyUsed = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM qa_usage_ledger
      WHERE user_id = ? AND course_id = ? AND day_key = ? AND status IN ('reserved', 'completed')
    `).get(userId, courseId, dayKey) as { cnt: number }).cnt;

    const totalUsed = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM qa_usage_ledger
      WHERE user_id = ? AND course_id = ? AND status IN ('reserved', 'completed')
    `).get(userId, courseId) as { cnt: number }).cnt;

    return {
      courseId,
      dayKey,
      emergencyQaPaused: globalSettings.emergencyQaPaused,
      dailyLimit,
      dailyUsed,
      dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
      totalLimit,
      totalUsed,
      totalRemaining: totalLimit === null ? null : Math.max(0, totalLimit - totalUsed),
      perMinuteLimit: policy.perMinuteLimit,
    };
  }

  reserveQuota(input: { userId: string; courseId: string; sessionId: string }): string {
    const now = this.now();
    const nowIso = now.toISOString();
    const oneMinuteAgoIso = new Date(now.getTime() - 60_000).toISOString();
    const dayKey = formatDayKey(now, this.timeZone());
    const ledgerId = randomUUID();

    const tx = this.db.transaction(() => {
      const global = this.getGlobalSettings();
      if (global.emergencyQaPaused) {
        throw new QuotaExceededError("QA_PAUSED", "教师当前已暂停课程答疑服务，请稍后再试（课程资料仍可正常阅读）");
      }

      const policy = this.getCoursePolicy(input.courseId);
      const override = this.db.prepare(`
        SELECT daily_qa_limit, total_qa_limit FROM student_quota_overrides WHERE user_id = ? AND course_id = ?
      `).get(input.userId, input.courseId) as { daily_qa_limit: number | null; total_qa_limit: number | null } | undefined;

      const concurrent = (this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM qa_usage_ledger WHERE user_id = ? AND status = 'reserved'
      `).get(input.userId) as { cnt: number }).cnt;
      if (concurrent >= policy.maxConcurrent) {
        throw new QuotaExceededError("CONCURRENT_LIMIT", "您当前有正在进行的答疑请求，请等待当前回答完成后再提问");
      }

      const perMinuteUsed = (this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM qa_usage_ledger
        WHERE user_id = ? AND created_at >= ? AND status IN ('reserved', 'completed')
      `).get(input.userId, oneMinuteAgoIso) as { cnt: number }).cnt;
      if (perMinuteUsed >= policy.perMinuteLimit) {
        throw new QuotaExceededError("RATE_LIMITED", "提问频率过快，请稍等 1 分钟后再试");
      }

      if (global.globalDailyQaLimit !== null) {
        const globalDailyCount = (this.db.prepare(`
          SELECT COUNT(*) AS cnt FROM qa_usage_ledger WHERE day_key = ? AND status IN ('reserved', 'completed')
        `).get(dayKey) as { cnt: number }).cnt;
        if (globalDailyCount >= global.globalDailyQaLimit) {
          throw new QuotaExceededError("GLOBAL_DAILY_LIMIT", "今日全站答疑次数已达上限，请明天再试");
        }
      }

      if (global.globalDailyTokenLimit !== null) {
        const globalDailyTokens = (this.db.prepare(`
          SELECT COALESCE(SUM(total_tokens), 0) AS total FROM qa_usage_ledger WHERE day_key = ? AND status = 'completed'
        `).get(dayKey) as { total: number }).total;
        if (globalDailyTokens >= global.globalDailyTokenLimit) {
          throw new QuotaExceededError("GLOBAL_TOKEN_LIMIT", "今日全站答疑用量已达上限，请明天再试");
        }
      }

      const dailyLimit = override?.daily_qa_limit ?? policy.dailyQaLimit;
      const dailyUsed = (this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM qa_usage_ledger
        WHERE user_id = ? AND course_id = ? AND day_key = ? AND status IN ('reserved', 'completed')
      `).get(input.userId, input.courseId, dayKey) as { cnt: number }).cnt;
      if (dailyUsed >= dailyLimit) {
        throw new QuotaExceededError(
          "DAILY_QUOTA_EXCEEDED",
          dailyLimit === 0 ? "您在本课程的答疑权限暂未开放" : `您今日在本课程的答疑次数已用完（上限 ${dailyLimit} 次）`,
        );
      }

      const totalLimit = override?.total_qa_limit ?? policy.totalQaLimit;
      if (totalLimit !== null) {
        const totalUsed = (this.db.prepare(`
          SELECT COUNT(*) AS cnt FROM qa_usage_ledger
          WHERE user_id = ? AND course_id = ? AND status IN ('reserved', 'completed')
        `).get(input.userId, input.courseId) as { cnt: number }).cnt;
        if (totalUsed >= totalLimit) {
          throw new QuotaExceededError("TOTAL_QUOTA_EXCEEDED", `您在本课程的累计答疑次数已用完（上限 ${totalLimit} 次）`);
        }
      }

      this.db.prepare(`
        INSERT INTO qa_usage_ledger (id, user_id, course_id, session_id, day_key, status, prompt_tokens, completion_tokens, total_tokens, created_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', 0, 0, 0, ?)
      `).run(ledgerId, input.userId, input.courseId, input.sessionId, dayKey, nowIso);
    });
    tx.immediate();
    return ledgerId;
  }

  completeQuota(ledgerId: string, usage?: Partial<TokenUsage>): void {
    const nowIso = this.now().toISOString();
    const promptTokens = Math.max(0, Math.floor(usage?.promptTokens ?? 0));
    const completionTokens = Math.max(0, Math.floor(usage?.completionTokens ?? 0));
    const totalTokens = Math.max(promptTokens + completionTokens, Math.floor(usage?.totalTokens ?? 0));

    this.db.prepare(`
      UPDATE qa_usage_ledger
      SET status = 'completed', prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, finished_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(promptTokens, completionTokens, totalTokens, nowIso, ledgerId);
  }

  refundQuota(ledgerId: string, reason: string): void {
    const nowIso = this.now().toISOString();
    this.db.prepare(`
      UPDATE qa_usage_ledger
      SET status = 'refunded', refund_reason = ?, finished_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(reason.slice(0, 120), nowIso, ledgerId);
  }

  refundOrphanedReservations(): number {
    const nowIso = this.now().toISOString();
    const info = this.db.prepare(`
      UPDATE qa_usage_ledger
      SET status = 'refunded', refund_reason = 'server_restart', finished_at = ?
      WHERE status = 'reserved'
    `).run(nowIso);
    return info.changes;
  }

  getAdminDashboard(courseIds: string[]) {
    const now = this.now();
    const todayKey = formatDayKey(now, this.timeZone());
    const yesterdayKey = formatDayKey(new Date(now.getTime() - 86_400_000), this.timeZone());

    const todayRow = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total_tokens), 0) AS tokens
      FROM qa_usage_ledger WHERE day_key = ? AND status = 'completed'
    `).get(todayKey) as { count: number; tokens: number };

    const yesterdayRow = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total_tokens), 0) AS tokens
      FROM qa_usage_ledger WHERE day_key = ? AND status = 'completed'
    `).get(yesterdayKey) as { count: number; tokens: number };

    const activeConcurrent = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM qa_usage_ledger WHERE status = 'reserved'
    `).get() as { count: number }).count;

    const coursePolicies = courseIds.map((id) => this.getCoursePolicy(id));

    const studentUsageRows = this.db.prepare(`
      SELECT
        u.id AS user_id,
        u.username,
        u.display_name,
        ce.course_id,
        COALESCE(SUM(CASE WHEN l.day_key = ? AND l.status IN ('reserved', 'completed') THEN 1 ELSE 0 END), 0) AS daily_used,
        COALESCE(SUM(CASE WHEN l.status IN ('reserved', 'completed') THEN 1 ELSE 0 END), 0) AS total_used,
        COALESCE(SUM(CASE WHEN l.status = 'completed' THEN l.total_tokens ELSE 0 END), 0) AS total_tokens,
        so.daily_qa_limit AS override_daily,
        so.total_qa_limit AS override_total,
        so.note AS override_note
      FROM users u
      JOIN course_enrollments ce ON ce.user_id = u.id
      LEFT JOIN qa_usage_ledger l ON l.user_id = u.id AND l.course_id = ce.course_id
      LEFT JOIN student_quota_overrides so ON so.user_id = u.id AND so.course_id = ce.course_id
      WHERE u.role = 'student'
      GROUP BY u.id, ce.course_id
      ORDER BY daily_used DESC, total_used DESC, u.username ASC
    `).all(todayKey) as Array<{
      user_id: string;
      username: string;
      display_name: string;
      course_id: string;
      daily_used: number;
      total_used: number;
      total_tokens: number;
      override_daily: number | null;
      override_total: number | null;
      override_note: string | null;
    }>;

    return {
      todayKey,
      globalSettings: this.getGlobalSettings(),
      stats: {
        todayCount: todayRow.count,
        todayTokens: todayRow.tokens,
        yesterdayCount: yesterdayRow.count,
        yesterdayTokens: yesterdayRow.tokens,
        activeConcurrent,
      },
      coursePolicies,
      studentUsage: studentUsageRows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        courseId: r.course_id,
        dailyUsed: r.daily_used,
        totalUsed: r.total_used,
        totalTokens: r.total_tokens,
        overrideDailyLimit: r.override_daily,
        overrideTotalLimit: r.override_total,
        overrideNote: r.override_note ?? "",
      })),
    };
  }
}
