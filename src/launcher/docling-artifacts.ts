import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DOCLING_ARTIFACTS_MARKER = ".course-agent-docling.json";

export interface DoclingDownloadSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputDirectory: string;
}

export async function prepareDoclingArtifacts(options: {
  releaseRoot: string;
  localAppData: string;
  doclingServeVersion: string;
  runDownload(spec: DoclingDownloadSpec): Promise<void>;
}): Promise<string> {
  const releaseRoot = path.resolve(options.releaseRoot);
  const bundled = path.join(releaseRoot, "models", "docling");
  if (await isCompleteCache(bundled, releaseRoot, "full", options.doclingServeVersion)) return bundled;

  const modelsRoot = path.resolve(options.localAppData, "CourseAgent", "models");
  await mkdir(modelsRoot, { recursive: true });
  if (!isWithin(options.localAppData, modelsRoot) || await hasSymbolicLink(options.localAppData, modelsRoot)) throw new Error("Docling model cache root must not contain a symbolic link");
  const local = path.join(modelsRoot, "docling");
  if (await isCompleteCache(local, modelsRoot, "downloaded", options.doclingServeVersion)) return local;

  const staging = await mkdtemp(path.join(modelsRoot, ".docling-download-"));
  let stagingExists = true;
  try {
    const spec: DoclingDownloadSpec = {
      command: path.join(releaseRoot, "runtime", "python", "python.exe"),
      args: ["-m", "docling.cli.tools", "models", "download", "--output-dir", staging],
      cwd: releaseRoot,
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", HF_HUB_DISABLE_XET: "1" },
      outputDirectory: staging,
    };
    await options.runDownload(spec);
    if (!(await hasDownloadedArtifacts(staging))) throw new Error("Docling model download did not produce artifacts");
    await writeMarker(staging, options.doclingServeVersion);
    await replaceDirectory(local, staging);
    stagingExists = false;
    return local;
  } finally {
    if (stagingExists) await removePath(staging).catch(() => undefined);
  }
}

async function isCompleteCache(directory: string, boundary: string, mode: "full" | "downloaded", version: string): Promise<boolean> {
  if (!isWithin(boundary, directory)) return false;
  try {
    if (await hasSymbolicLink(boundary, directory)) return false;
    if (await directoryContainsSymbolicLink(directory)) return false;
    const markerPath = path.join(directory, DOCLING_ARTIFACTS_MARKER);
    if ((await lstat(markerPath)).isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || marker.provider !== "docling" || marker.doclingServeVersion !== version || marker.mode !== mode || marker.complete !== true) return false;
    return (await readdir(directory)).some((name) => name !== DOCLING_ARTIFACTS_MARKER);
  } catch { return false; }
}

async function hasDownloadedArtifacts(directory: string): Promise<boolean> {
  if ((await lstat(directory)).isSymbolicLink()) return false;
  if (await directoryContainsSymbolicLink(directory)) return false;
  return (await readdir(directory)).some((name) => name !== DOCLING_ARTIFACTS_MARKER);
}

async function writeMarker(directory: string, version: string): Promise<void> {
  const marker = path.join(directory, DOCLING_ARTIFACTS_MARKER);
  const temporary = path.join(directory, `.marker-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, provider: "docling", doclingServeVersion: version, mode: "downloaded", complete: true })}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, marker);
}

async function replaceDirectory(target: string, staging: string): Promise<void> {
  const backup = path.join(path.dirname(target), `.docling-invalid-${randomUUID()}`);
  let moved = false;
  try {
    if (await exists(target)) { await rename(target, backup); moved = true; }
    await rename(staging, target);
  } catch (error) {
    if (moved && !(await exists(target))) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  if (moved) await removePath(backup).catch(() => undefined);
}

async function removePath(value: string): Promise<void> {
  try {
    const stat = await lstat(value);
    if (stat.isSymbolicLink() || !stat.isDirectory()) await unlink(value);
    else {
      for (const name of await readdir(value)) await removePath(path.join(value, name));
      await rmdir(value);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function directoryContainsSymbolicLink(directory: string): Promise<boolean> {
  for (const name of await readdir(directory)) {
    const child = path.join(directory, name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory() && await directoryContainsSymbolicLink(child)) return true;
  }
  return false;
}

async function hasSymbolicLink(boundary: string, target: string): Promise<boolean> {
  const relative = path.relative(path.resolve(boundary), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return true;
  let current = path.resolve(boundary);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

function isWithin(boundary: string, target: string): boolean {
  const relative = path.relative(path.resolve(boundary), path.resolve(target));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(value: string): Promise<boolean> {
  try { await lstat(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
