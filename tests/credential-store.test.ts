import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore, WindowsDpapiProtector, type SecretProtector } from "../src/config/credential-store.js";

const roots: string[] = [];
const fakeProtector: SecretProtector = {
  protect: async (plaintext) => Buffer.from(`protected:${plaintext.toString("base64")}`),
  unprotect: async (ciphertext) => Buffer.from(ciphertext.toString().slice("protected:".length), "base64"),
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it("stores provider keys outside the workspace without plaintext", async () => {
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-secrets-"));
  roots.push(secretRoot);
  const store = new FileCredentialStore(secretRoot, fakeProtector);
  await store.setApiKey("primary/provider", "top-secret-key");

  await expect(store.getApiKey("primary/provider")).resolves.toBe("top-secret-key");
  const [storedFile] = await readdir(secretRoot);
  const disk = await readFile(path.join(secretRoot, storedFile!));
  expect(disk.toString()).not.toContain("top-secret-key");
  await expect(store.listProviderIds()).resolves.toEqual(["primary/provider"]);
});

it("supports deleting a provider key", async () => {
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-secrets-"));
  roots.push(secretRoot);
  const store = new FileCredentialStore(secretRoot, fakeProtector);
  await store.setApiKey("vision", "vision-secret");
  await store.deleteApiKey("vision");
  await expect(store.getApiKey("vision")).resolves.toBeUndefined();
});

it.runIf(process.platform === "win32")("round-trips a value with Windows CurrentUser DPAPI", async () => {
  const protector = new WindowsDpapiProtector();
  const ciphertext = await protector.protect(Buffer.from("dpapi-roundtrip-test"));
  expect(ciphertext.toString()).not.toContain("dpapi-roundtrip-test");
  await expect(protector.unprotect(ciphertext)).resolves.toEqual(Buffer.from("dpapi-roundtrip-test"));
});
