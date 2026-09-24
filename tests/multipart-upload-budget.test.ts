import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MultipartAttachmentBudget, rejectMultipartFile } from "../src/api/multipart-upload-budget.js";

describe("MultipartAttachmentBudget", () => {
  it("stops consuming a file stream at the first chunk that exceeds the aggregate cap", async () => {
    let chunksRead = 0;
    let streamClosed = false;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      try {
        for (let index = 0; index < 100; index += 1) {
          chunksRead += 1;
          yield new Uint8Array(2);
        }
      } finally {
        streamClosed = true;
      }
    }
    const budget = new MultipartAttachmentBudget(5);

    await expect(budget.read(chunks())).rejects.toMatchObject({
      code: "SUBMISSION_ASSET_TOTAL_TOO_LARGE",
    });
    expect(chunksRead).toBe(3);
    expect(streamClosed).toBe(true);
  });

  it("accepts exactly the attachment aggregate limit", async () => {
    const budget = new MultipartAttachmentBudget(5);

    await expect(budget.read(Readable.from([new Uint8Array(2), new Uint8Array(3)]))).resolves.toHaveLength(5);
  });

  it("destroys a multipart file stream before rejecting a disallowed file part", () => {
    const stream = new Readable({ read() {} });
    const destroy = vi.spyOn(stream, "destroy");

    expect(() => rejectMultipartFile(stream, new Error("not allowed"))).toThrow("not allowed");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
