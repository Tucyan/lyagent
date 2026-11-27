import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function openStudentDatabase(workspaceRoot: string, nowIso = () => new Date().toISOString()): Database.Database {
  const stateDir = path.join(path.resolve(workspaceRoot), "state");
  mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "student-portal.sqlite");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrateStudentDatabase(db, nowIso);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function acquireStudentWorkspaceLock(canonicalRoot: string): () => void {
  const stateDir = path.join(canonicalRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  const lock = new Database(path.join(stateDir, "student-portal-instance.sqlite"), { timeout: 0 });
  try {
    // Hold the writer lock for the server's lifetime. SQLite releases it when the process exits.
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY") {
      throw new Error("该 Workspace 的学生端服务已在运行", { cause: error });
    }
    throw error;
  }
  return () => lock.close();
}

function migrateStudentDatabase(db: Database.Database, nowIso: () => string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  if (current >= SCHEMA_VERSION) return;

  const applyV1 = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

      CREATE TABLE IF NOT EXISTS course_enrollments (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL,
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, course_id)
      );
      CREATE INDEX IF NOT EXISTS idx_course_enrollments_course ON course_enrollments(course_id);

      CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY COLLATE NOCASE,
        label TEXT NOT NULL,
        course_ids_json TEXT NOT NULL,
        max_uses INTEGER,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id),
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS global_quota_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        emergency_qa_paused INTEGER NOT NULL DEFAULT 0,
        global_daily_qa_limit INTEGER,
        global_daily_token_limit INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS course_quota_policies (
        course_id TEXT PRIMARY KEY,
        daily_qa_limit INTEGER NOT NULL DEFAULT 20,
        total_qa_limit INTEGER,
        per_minute_limit INTEGER NOT NULL DEFAULT 3,
        max_concurrent INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS student_quota_overrides (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL,
        daily_qa_limit INTEGER,
        total_qa_limit INTEGER,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, course_id)
      );

      CREATE TABLE IF NOT EXISTS qa_usage_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'refunded')),
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        refund_reason TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_user_course_day ON qa_usage_ledger(user_id, course_id, day_key, status);
      CREATE INDEX IF NOT EXISTS idx_ledger_day_status ON qa_usage_ledger(day_key, status);
      CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON qa_usage_ledger(user_id, created_at);
    `);

    const now = nowIso();
    db.prepare(`
      INSERT OR IGNORE INTO global_quota_settings (id, emergency_qa_paused, global_daily_qa_limit, global_daily_token_limit, updated_at)
      VALUES (1, 0, NULL, NULL, ?)
    `).run(now);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, now);
  });

  applyV1();
}
