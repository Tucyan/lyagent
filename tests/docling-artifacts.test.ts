import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCLING_ARTIFACTS_MARKER,
  prepareDoclingArtifacts,
  type DoclingDownloadSpec,
} from "../src/launcher/docling-artifacts.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "docling-artifacts-"));
  roots.push(root);
  const releaseRoot = path.join(root, "发布 包");
  const localAppData = path.join(root, "Local App Data");
  await mkdir(releaseRoot, { recursive: true });
  await mkdir(localAppData, { recursive: true });
  return { releaseRoot, localAppData };
}

async function complete(directory: string, mode: "full" | "downloaded", version = "1.28.0") {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "model.bin"), "synthetic artifact");
  await writeFile(path.join(directory, DOCLING_ARTIFACTS_MARKER), JSON.stringify({ schemaVersion: 1, provider: "docling", doclingServeVersion: version, mode, complete: true }));
}

describe("Docling artifact preparation", () => {
  it("uses a complete bundled Full cache without downloading", async () => {
    const value = await fixture();
    const bundled = path.join(value.releaseRoot, "models", "docling");
    await complete(bundled, "full");
    const runDownload = vi.fn();

    await expect(prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload })).resolves.toBe(bundled);
    expect(runDownload).not.toHaveBeenCalled();
  });

  it("reuses a complete LocalAppData cache without downloading", async () => {
    const value = await fixture();
    const local = path.join(value.localAppData, "CourseAgent", "models", "docling");
    await complete(local, "downloaded");
    const runDownload = vi.fn();

    await expect(prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload })).resolves.toBe(local);
    expect(runDownload).not.toHaveBeenCalled();
  });

  it.each(["missing", "damaged", "wrong-version"] as const)("downloads into staging and atomically replaces a %s local cache", async (state) => {
    const value = await fixture();
    const local = path.join(value.localAppData, "CourseAgent", "models", "docling");
    if (state !== "missing") {
      await mkdir(local, { recursive: true });
      await writeFile(path.join(local, "stale.bin"), "stale");
      await writeFile(path.join(local, DOCLING_ARTIFACTS_MARKER), state === "damaged" ? "not json" : JSON.stringify({ schemaVersion: 1, provider: "docling", doclingServeVersion: "0.0.0", mode: "downloaded", complete: true }));
    }
    const specs: DoclingDownloadSpec[] = [];
    const runDownload = async (spec: DoclingDownloadSpec) => {
      specs.push(spec);
      await writeFile(path.join(spec.outputDirectory, "model.bin"), "downloaded");
    };

    await expect(prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload })).resolves.toBe(local);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      command: path.join(value.releaseRoot, "runtime", "python", "python.exe"),
      args: ["-m", "docling.cli.tools", "models", "download", "--output-dir", expect.stringContaining(".docling-download-")],
      cwd: value.releaseRoot,
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", HF_HUB_DISABLE_XET: "1" },
    });
    expect(JSON.parse(await readFile(path.join(local, DOCLING_ARTIFACTS_MARKER), "utf8"))).toMatchObject({ doclingServeVersion: "1.28.0", mode: "downloaded", complete: true });
    expect(await readFile(path.join(local, "model.bin"), "utf8")).toBe("downloaded");
  });

  it("does not publish a completion marker when download fails", async () => {
    const value = await fixture();
    const local = path.join(value.localAppData, "CourseAgent", "models", "docling");
    await expect(prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
    await expect(readFile(path.join(local, DOCLING_ARTIFACTS_MARKER), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects bundled and local symlink caches instead of following them outside their roots", async () => {
    const value = await fixture();
    const outside = path.join(value.releaseRoot, "outside");
    await complete(outside, "full");
    await mkdir(path.join(value.releaseRoot, "models"), { recursive: true });
    await symlink(outside, path.join(value.releaseRoot, "models", "docling"), "junction");
    const localOutside = path.join(value.localAppData, "outside");
    await complete(localOutside, "downloaded");
    await mkdir(path.join(value.localAppData, "CourseAgent", "models"), { recursive: true });
    await symlink(localOutside, path.join(value.localAppData, "CourseAgent", "models", "docling"), "junction");
    const runDownload = vi.fn(async (spec: DoclingDownloadSpec) => { await writeFile(path.join(spec.outputDirectory, "model.bin"), "safe"); });

    const resolved = await prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload });
    expect(resolved).toBe(path.join(value.localAppData, "CourseAgent", "models", "docling"));
    expect(runDownload).toHaveBeenCalledOnce();
    expect(await readFile(path.join(outside, "model.bin"), "utf8")).toBe("synthetic artifact");
    expect(await readFile(path.join(localOutside, "model.bin"), "utf8")).toBe("synthetic artifact");
  });

  it("rejects a CourseAgent parent junction that redirects the cache outside LocalAppData", async () => {
    const value = await fixture();
    const outside = path.join(path.dirname(value.localAppData), "outside-course-agent");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(value.localAppData, "CourseAgent"), "junction");
    const runDownload = vi.fn();

    await expect(prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload })).rejects.toThrow(/symbolic link/i);
    expect(runDownload).not.toHaveBeenCalled();
  });

  it("does not trust a complete marker when the cache contains a nested junction", async () => {
    const value = await fixture();
    const local = path.join(value.localAppData, "CourseAgent", "models", "docling");
    await complete(local, "downloaded");
    const outside = path.join(value.localAppData, "outside-nested");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(local, "redirected"), "junction");
    const runDownload = vi.fn(async (spec: DoclingDownloadSpec) => { await writeFile(path.join(spec.outputDirectory, "model.bin"), "safe"); });

    await expect(prepareDoclingArtifacts({ ...value, doclingServeVersion: "1.28.0", runDownload })).resolves.toBe(local);
    expect(runDownload).toHaveBeenCalledOnce();
  });
});
