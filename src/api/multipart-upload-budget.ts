import { SubmissionAssetError } from "../services/grading-session-service.js";

export const MAX_MULTIPART_FILE_BYTES = 50 * 1024 * 1024;

export class MultipartAttachmentBudget {
  private totalBytes = 0;

  constructor(private readonly maxBytes = MAX_MULTIPART_FILE_BYTES) {}

  async read(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      if (this.totalBytes + bytes.byteLength > this.maxBytes) {
        const destroyable = stream as AsyncIterable<Uint8Array> & { destroy?: () => void };
        destroyable.destroy?.();
        throw new SubmissionAssetError(
          "SUBMISSION_ASSET_TOTAL_TOO_LARGE",
          "上传文件总量不能超过 50 MiB",
        );
      }
      fileBytes += bytes.byteLength;
      this.totalBytes += bytes.byteLength;
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, fileBytes);
  }
}

export function rejectMultipartFile(stream: { destroy?: () => unknown }, error: Error): never {
  stream.destroy?.();
  throw error;
}
