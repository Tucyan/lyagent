import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekStudentIdentityClient,
  StudentIdentityError,
  resolveStudentIdentity,
  type StudentIdentityClient,
} from "../src/services/student-identity-service.js";

describe("student identity resolution", () => {
  it("uses complete manual identity without calling AI", async () => {
    const client: StudentIdentityClient = { identify: vi.fn() };
    await expect(resolveStudentIdentity({ studentName: " 张晓明 ", studentNumber: " 20260001 ", filename: "ignored.docx", client })).resolves.toEqual({ studentName: "张晓明", studentNumber: "20260001" });
    expect(client.identify).not.toHaveBeenCalled();
  });

  it("rejects a partial manual identity without calling AI", async () => {
    const client: StudentIdentityClient = { identify: vi.fn() };
    await expect(resolveStudentIdentity({ studentName: "张晓明", studentNumber: "", filename: "ignored.docx", client })).rejects.toMatchObject({
      code: "STUDENT_IDENTITY_FIELDS_REQUIRED",
    });
    expect(client.identify).not.toHaveBeenCalled();
  });

  it("parses a standard filename locally before calling AI", async () => {
    const client: StudentIdentityClient = { identify: vi.fn() };
    await expect(resolveStudentIdentity({
      studentName: "",
      studentNumber: "",
      filename: "20260001_张晓明_生成式AI生活助手报告.md",
      client,
    })).resolves.toEqual({ studentName: "张晓明", studentNumber: "20260001" });
    expect(client.identify).not.toHaveBeenCalled();
  });

  it("sends only a bounded basename to AI when both fields are empty", async () => {
    const client: StudentIdentityClient = { identify: vi.fn(async () => ({ studentName: "张晓明", studentNumber: "20260001" })) };
    await expect(resolveStudentIdentity({ studentName: "", studentNumber: "", filename: `C:\\secret\\${"x".repeat(300)}_报告.docx`, client })).resolves.toEqual({ studentName: "张晓明", studentNumber: "20260001" });
    const sent = vi.mocked(client.identify).mock.calls[0]![0];
    expect(sent).not.toContain("secret");
    expect(sent.endsWith(".docx")).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(200);
  });

  it("rejects incomplete AI output", async () => {
    const client: StudentIdentityClient = { identify: vi.fn(async () => ({ studentName: "张晓明", studentNumber: "" })) };
    await expect(resolveStudentIdentity({ studentName: "", studentNumber: "", filename: "report.docx", client })).rejects.toBeInstanceOf(StudentIdentityError);
  });

  it("validates strict JSON from the direct OpenAI-compatible client", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"studentName":"张晓明","studentNumber":"20260001"}' } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new DeepSeekStudentIdentityClient({ apiKey: "secret", fetchImpl });
    await expect(client.identify("20260001_张晓明_报告.docx")).resolves.toEqual({ studentName: "张晓明", studentNumber: "20260001" });
    const request = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(request.messages.at(-1).content).toBe("20260001_张晓明_报告.docx");
    expect(JSON.stringify(request)).not.toContain("student report body");
  });

  it("rejects non-JSON provider output", async () => {
    const client = new DeepSeekStudentIdentityClient({ apiKey: "secret", fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "张晓明 20260001" } }] }), { status: 200 }) });
    await expect(client.identify("report.docx")).rejects.toMatchObject({
      code: "STUDENT_IDENTITY_INVALID_JSON",
    });
  });

  it("returns stable codes for model timeout and non-extractable identity", async () => {
    const timeout = new DeepSeekStudentIdentityClient({
      apiKey: "secret",
      fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); },
    });
    await expect(timeout.identify("report.docx")).rejects.toMatchObject({
      code: "STUDENT_IDENTITY_TIMEOUT",
    });

    const client: StudentIdentityClient = {
      identify: vi.fn(async () => { throw new StudentIdentityError("cannot extract", "STUDENT_IDENTITY_NOT_FOUND"); }),
    };
    await expect(resolveStudentIdentity({
      studentName: "",
      studentNumber: "",
      filename: "report.docx",
      client,
    })).rejects.toMatchObject({ code: "STUDENT_IDENTITY_NOT_FOUND" });
  });
});
