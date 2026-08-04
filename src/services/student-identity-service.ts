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

export class StudentIdentityError extends Error {
  constructor(message: string) {
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
  if (Boolean(studentName) !== Boolean(studentNumber)) throw new StudentIdentityError("Both student name and number must be provided together");
  if (studentName && studentNumber) return parseIdentity({ studentName, studentNumber });
  if (!input.client) throw new StudentIdentityError("Student identity could not be inferred; enter both student name and number");
  const filename = boundedBasename(input.filename);
  try {
    return parseIdentity(await input.client.identify(filename));
  } catch (error: unknown) {
    if (error instanceof StudentIdentityError) throw error;
    throw new StudentIdentityError("Student identity could not be inferred; enter both student name and number");
  }
}

export class DeepSeekStudentIdentityClient implements StudentIdentityClient {
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
    } catch {
      throw new StudentIdentityError("Student identity request failed or timed out");
    }
    if (!response.ok) throw new StudentIdentityError("Student identity request failed");
    try {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("missing content");
      return parseIdentity(JSON.parse(content));
    } catch {
      throw new StudentIdentityError("Student identity model returned invalid JSON");
    }
  }
}

function parseIdentity(value: unknown): StudentIdentity {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new StudentIdentityError("Student identity is incomplete or invalid");
  return parsed.data;
}

function boundedBasename(filename: string): string {
  const basename = path.win32.basename(filename.trim()).replace(/[\u0000-\u001f]/g, "");
  if (!basename) throw new StudentIdentityError("Filename is required for identity inference");
  if (basename.length <= 200) return basename;
  const extension = path.extname(basename).slice(0, 16);
  return `${basename.slice(0, 200 - extension.length)}${extension}`;
}
