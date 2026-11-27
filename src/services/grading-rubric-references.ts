import { stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const referenceTables = ["grading_sessions", "grading_batches", "grading_batch_uploads"];

export async function hasGradingRubricReferences(root: string, assignmentId: string): Promise<boolean> {
  const databasePath = path.join(root, "grading.sqlite");
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    // Rubric-only workspaces and older grading databases may lack some of these tables.
    const hasTable = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    return referenceTables.some((table) => hasTable.get(table)
      && database.prepare(`SELECT 1 FROM ${table} WHERE assignment_id = ? COLLATE NOCASE LIMIT 1`).get(assignmentId));
  } finally {
    database.close();
  }
}
