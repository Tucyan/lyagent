import type Database from "better-sqlite3";

export function migrateGradingSessions(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS grading_sessions (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      rubric_version INTEGER NOT NULL,
      rubric_hash TEXT NOT NULL,
      batch_id TEXT NOT NULL UNIQUE,
      student_key TEXT NOT NULL UNIQUE,
      student_name TEXT NOT NULL,
      student_number TEXT NOT NULL,
      title TEXT NOT NULL,
      submission_title TEXT,
      submission_title_status TEXT NOT NULL DEFAULT 'pending',
      submission_title_error_code TEXT,
      submission_title_error_message TEXT,
      submission_title_last_failed_at TEXT,
      auto_start INTEGER NOT NULL CHECK (auto_start IN (0, 1)),
      conversion_status TEXT NOT NULL,
      conversion_attempt_count INTEGER NOT NULL DEFAULT 0,
      conversion_error_code TEXT,
      conversion_error_message TEXT,
      conversion_retryable INTEGER NOT NULL DEFAULT 0,
      conversion_last_failed_at TEXT,
      conversion_next_retry_at TEXT,
      grading_status TEXT NOT NULL,
      active_run_id TEXT,
      deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1)),
      submission_version INTEGER,
      submission_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grading_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES grading_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      external_task_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, kind)
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES grading_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      input_message TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_run_events (
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );
  `);
  const columns = new Set(
    (
      database
        .prepare("PRAGMA table_info(grading_sessions)")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name),
  );
  if (!columns.has("submission_title"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN submission_title TEXT",
    );
  if (!columns.has("submission_title_status"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN submission_title_status TEXT NOT NULL DEFAULT 'pending'",
    );
  if (!columns.has("submission_title_error_code"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN submission_title_error_code TEXT",
    );
  if (!columns.has("submission_title_error_message"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN submission_title_error_message TEXT",
    );
  if (!columns.has("submission_title_last_failed_at"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN submission_title_last_failed_at TEXT",
    );
  if (!columns.has("conversion_attempt_count"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN conversion_attempt_count INTEGER NOT NULL DEFAULT 0",
    );
  if (!columns.has("conversion_error_code"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN conversion_error_code TEXT",
    );
  if (!columns.has("conversion_error_message"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN conversion_error_message TEXT",
    );
  if (!columns.has("conversion_retryable"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN conversion_retryable INTEGER NOT NULL DEFAULT 0",
    );
  if (!columns.has("conversion_last_failed_at"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN conversion_last_failed_at TEXT",
    );
  if (!columns.has("conversion_next_retry_at"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN conversion_next_retry_at TEXT",
    );
  if (!columns.has("deletion_pending"))
    database.exec(
      "ALTER TABLE grading_sessions ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1))",
    );
  database.exec(
    `UPDATE grading_sessions SET submission_title_status = 'failed',
     submission_title_error_code = COALESCE(submission_title_error_code, 'LEGACY_SUBMISSION_TITLE_FAILURE'),
     submission_title_error_message = COALESCE(submission_title_error_message, '作业名称识别被应用重启中断，请重试'),
     submission_title_last_failed_at = COALESCE(submission_title_last_failed_at, updated_at)
     WHERE submission_title_status = 'resolving'`,
  );
  database.exec(
    `UPDATE grading_sessions SET
     submission_title_error_code = COALESCE(submission_title_error_code, 'LEGACY_SUBMISSION_TITLE_FAILURE'),
     submission_title_error_message = COALESCE(submission_title_error_message, '作业名称识别失败，请重试'),
     submission_title_last_failed_at = COALESCE(submission_title_last_failed_at, updated_at)
     WHERE submission_title_status = 'failed'`,
  );
  database.exec(`UPDATE grading_sessions SET
    conversion_status = CASE
      WHEN EXISTS (SELECT 1 FROM grading_jobs WHERE grading_jobs.session_id = grading_sessions.id AND kind = 'conversion' AND external_task_id IS NOT NULL) THEN 'conversion_failed'
      ELSE 'waiting_for_converter'
    END,
    conversion_error_code = 'LEGACY_CONVERSION_FAILURE',
    conversion_error_message = '转换失败，旧记录未保存具体原因。',
    conversion_retryable = CASE
      WHEN EXISTS (SELECT 1 FROM grading_jobs WHERE grading_jobs.session_id = grading_sessions.id AND kind = 'conversion' AND external_task_id IS NOT NULL) THEN 0
      ELSE 1
    END,
    conversion_last_failed_at = updated_at
    WHERE conversion_status = 'failed'`);
  database.pragma("user_version = 5");
}
