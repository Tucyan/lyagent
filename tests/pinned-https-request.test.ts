import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generate as generateSelfSignedCertificate } from "selfsigned";
import { createPinnedHttpsRequest } from "../src/services/safe-web-fetcher.js";

async function createTlsIdentity() {
  const notBeforeDate = new Date(Date.now() - 60_000);
  const notAfterDate = new Date(Date.now() + 5 * 60_000);
  return generateSelfSignedCertificate([{ name: "commonName", value: "public.test" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "public.test" }] }],
  });
}

describe("pinned HTTPS connector", () => {
  it("dials the validated IP while preserving the URL host, SNI, and certificate validation", async () => {
    const { cert: certificate, private: privateKey } = await createTlsIdentity();
    let requestHost: string | undefined;
    let remoteAddress: string | undefined;
    let serverName: string | false | null | undefined;
    const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
      requestHost = request.headers.host;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("TLS pinned");
    });
    server.on("secureConnection", (socket) => {
      remoteAddress = socket.remoteAddress;
      serverName = socket.servername;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const request = createPinnedHttpsRequest({ ca: certificate });
      const response = await request(`https://public.test:${port}/proof`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "text/plain" },
      }, ["127.0.0.1"]);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("TLS pinned");
      expect(remoteAddress).toBe("127.0.0.1");
      expect(requestHost).toBe(`public.test:${port}`);
      expect(serverName).toBe("public.test");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a 205 response and closes its continuously streaming body", async () => {
    const { cert: certificate, private: privateKey } = await createTlsIdentity();
    let responseClosed = false;
    let bytesWritten = 0;
    let closeServerResponse!: () => void;
    let streamTimer: ReturnType<typeof setInterval> | undefined;
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    const serverResponseClosed = new Promise<void>((resolve) => { closeServerResponse = resolve; });
    const server = https.createServer({ cert: certificate, key: privateKey }, (_request, response) => {
      response.writeHead(205, { "content-type": "text/plain" });
      response.flushHeaders();
      response.on("close", () => {
        responseClosed = true;
        if (streamTimer) clearInterval(streamTimer);
        closeServerResponse();
      });
      streamTimer = setInterval(() => {
        if (response.write(Buffer.alloc(8 * 1024))) bytesWritten += 8 * 1024;
      }, 2);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const request = createPinnedHttpsRequest({ ca: certificate });
      await expect(request(`https://public.test:${port}/reset`, {
        signal: AbortSignal.timeout(1_000),
      }, ["127.0.0.1"])).rejects.toThrow("205");
      await Promise.race([
        serverResponseClosed,
        new Promise<never>((_resolve, reject) => {
          closeTimeout = setTimeout(() => reject(new Error("205 response stayed open")), 500);
        }),
      ]);
      expect(responseClosed).toBe(true);
      expect(bytesWritten).toBeLessThan(64 * 1024);
    } finally {
      if (streamTimer) clearInterval(streamTimer);
      if (closeTimeout) clearTimeout(closeTimeout);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects an invalid HTTP status without throwing from the response callback", async () => {
    const { cert: certificate, private: privateKey } = await createTlsIdentity();
    const server = https.createServer({ cert: certificate, key: privateKey }, (_request, response) => {
      response.writeHead(600, { "content-type": "text/plain" });
      response.end("invalid status");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const request = createPinnedHttpsRequest({ ca: certificate });
      await expect(request(`https://public.test:${port}/invalid`, {
        signal: AbortSignal.timeout(1_000),
      }, ["127.0.0.1"])).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
