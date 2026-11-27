import { createHash } from "node:crypto";
import type { SafeFilesystem } from "../core/safe-filesystem.js";

interface SubmissionIdentity {
  assignmentId: string;
  batchId: string;
  studentKey: string;
}

interface SubmissionMetadata extends SubmissionIdentity {
  sessionId: string;
  originalFilename: string;
  storedOriginal: string;
  originalHash: string;
  size: number;
  createdAt: string;
  assets?: string[];
  submissionVersion?: number;
  submissionHash?: string;
}

export class GradingSubmissionFiles {
  private readonly base: string;

  constructor(
    private readonly filesystem: SafeFilesystem,
    { assignmentId, batchId, studentKey }: SubmissionIdentity,
  ) {
    this.base = `assignments/${assignmentId}/submissions/${batchId}/${studentKey}`;
  }

  async copyOriginal(sourcePath: string, extension: string): Promise<string> {
    const storedOriginal = `original/submission${extension}`;
    await this.filesystem.copyInto(sourcePath, `${this.base}/${storedOriginal}`);
    return storedOriginal;
  }

  async readOriginal(): Promise<{ filename: string; bytes: Uint8Array }> {
    const metadata = await this.readMetadata();
    return {
      filename: metadata.originalFilename,
      bytes: new Uint8Array(
        await this.filesystem.readBytes(`${this.base}/${metadata.storedOriginal}`),
      ),
    };
  }

  async readMetadata(): Promise<SubmissionMetadata> {
    return JSON.parse(
      await this.filesystem.readText(`${this.base}/metadata.json`),
    ) as SubmissionMetadata;
  }

  writeMetadata(metadata: SubmissionMetadata): Promise<void> {
    return this.filesystem.writeText(
      `${this.base}/metadata.json`,
      JSON.stringify(metadata, null, 2),
    );
  }

  readMarkdown(version: number): Promise<string> {
    return this.filesystem.readText(
      `${this.base}/converted/${submissionMarkdownFilename(version)}`,
    );
  }

  writeMarkdown(version: number, markdown: string): Promise<void> {
    return this.filesystem.writeText(
      `${this.base}/converted/${submissionMarkdownFilename(version)}`,
      markdown,
    );
  }

  async readAsset(assetPath: string): Promise<Uint8Array> {
    return new Uint8Array(
      await this.filesystem.readBytes(`${this.base}/converted/${assetPath}`),
    );
  }

  async writeAssets(
    assets: Array<{ path: string; bytes: Uint8Array }>,
  ): Promise<string[]> {
    const assetHashes: string[] = [];
    for (const asset of assets) {
      await this.filesystem.writeBytes(
        `${this.base}/converted/${asset.path}`,
        asset.bytes,
      );
      assetHashes.push(hashSubmissionAsset(asset.path, asset.bytes));
    }
    return assetHashes;
  }
}

export function submissionMarkdownFilename(version: number): string {
  return `submission-v${version}.md`;
}

export function hashSubmission(
  originalHash: string,
  markdown: string,
  assets: string[],
): string {
  return sha256(
    Buffer.from(
      `${originalHash}\n${sha256(Buffer.from(markdown))}\n${assets.sort().join("\n")}`,
    ),
  );
}

export function hashSubmissionAsset(
  assetPath: string,
  bytes: Uint8Array,
): string {
  return `${assetPath}:${sha256(Buffer.from(bytes))}`;
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
