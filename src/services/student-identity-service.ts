import path from "node:path";
import { z } from "zod";

const identitySchema = z.object({
  studentName: z.string().trim().min(1).max(120),
  studentNumber: z.string().trim().min(1).max(80),
}).strict();

export type StudentIdentity = z.infer<typeof identitySchema>;

export interface StudentIdentityClient {
  identify(filename: string): Promise<StudentIdentity>;
}

export type StudentIdentityErrorCode =
  | "STUDENT_IDENTITY_FIELDS_REQUIRED"
  | "STUDENT_IDENTITY_NOT_FOUND"
  | "STUDENT_IDENTITY_TIMEOUT"
  | "STUDENT_IDENTITY_REQUEST_FAILED"
  | "STUDENT_IDENTITY_INVALID_JSON";

export class StudentIdentityError extends Error {
  constructor(
    message: string,
    readonly code: StudentIdentityErrorCode = "STUDENT_IDENTITY_NOT_FOUND",
  ) {
    super(message);
    this.name = "StudentIdentityError";
  }
}

export async function resolveStudentIdentity(input: {
  studentName: string;
  studentNumber: string;
  filename: string;
  client?: StudentIdentityClient;
}): Promise<StudentIdentity> {
  const studentName = input.studentName.trim();
  const studentNumber = input.studentNumber.trim();
  if (Boolean(studentName) !== Boolean(studentNumber))
    throw new StudentIdentityError(
      "姓名与学号必须同时填写",
      "STUDENT_IDENTITY_FIELDS_REQUIRED",
    );
  if (studentName && studentNumber) return parseIdentity({ studentName, studentNumber });
  const filename = boundedBasename(input.filename);
  const local = parseStandardFilename(filename);
  if (local) return local;
  if (!input.client)
    throw new StudentIdentityError(
      "无法从标准文件名识别学生，请补填姓名和学号",
      "STUDENT_IDENTITY_NOT_FOUND",
    );
  try {
    return parseIdentity(await input.client.identify(filename));
  } catch (error: unknown) {
    if (error instanceof StudentIdentityError) throw error;
    throw new StudentIdentityError(
      "学生身份识别请求失败，请补填姓名和学号后重试",
      "STUDENT_IDENTITY_REQUEST_FAILED",
    );
  }
}

export class OpenAICompatibleStudentIdentityClient implements StudentIdentityClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { apiKey: string; baseUrl?: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new StudentIdentityError("Student identity model is not configured");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.model = options.model ?? "deepseek-chat";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async identify(filename: string): Promise<StudentIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Extract studentName and studentNumber from the filename. Return only strict JSON with exactly those two string fields." },
            { role: "user", content: boundedBasename(filename) },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const timedOut = error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name);
      throw new StudentIdentityError(
        timedOut
          ? "学生身份识别超时，请补填姓名和学号后重试"
          : "学生身份识别请求失败，请稍后重试或补填姓名和学号",
        timedOut ? "STUDENT_IDENTITY_TIMEOUT" : "STUDENT_IDENTITY_REQUEST_FAILED",
      );
    }
    if (!response.ok)
      throw new StudentIdentityError(
        "学生身份识别请求失败，请稍后重试或补填姓名和学号",
        "STUDENT_IDENTITY_REQUEST_FAILED",
      );
    try {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("missing content");
      const decoded = JSON.parse(content) as unknown;
      return parseIdentity(decoded);
    } catch (error: unknown) {
      if (error instanceof StudentIdentityError) throw error;
      throw new StudentIdentityError(
        "学生身份识别返回了无效数据，请补填姓名和学号",
        "STUDENT_IDENTITY_INVALID_JSON",
      );
    }
  }
}

/** @deprecated Use OpenAICompatibleStudentIdentityClient. */
export const DeepSeekStudentIdentityClient = OpenAICompatibleStudentIdentityClient;

function parseIdentity(value: unknown): StudentIdentity {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success)
    throw new StudentIdentityError(
      "无法从文件名提取完整学生身份，请补填姓名和学号",
      "STUDENT_IDENTITY_NOT_FOUND",
    );
  return parsed.data;
}

function parseStandardFilename(filename: string): StudentIdentity | undefined {
  const stem = filename.slice(0, filename.length - path.extname(filename).length);
  const match = /^([A-Za-z0-9]{3,80})[_-]([^_-]{1,120})[_-].+$/u.exec(stem);
  if (!match) return undefined;
  return parseIdentity({
    studentNumber: match[1],
    studentName: match[2]?.trim(),
  });
}

function boundedBasename(filename: string): string {
  const basename = path.win32.basename(filename.trim()).replace(/[\u0000-\u001f]/g, "");
  if (!basename) throw new StudentIdentityError("Filename is required for identity inference");
  if (basename.length <= 200) return basename;
  const extension = path.extname(basename).slice(0, 16);
  return `${basename.slice(0, 200 - extension.length)}${extension}`;
}
