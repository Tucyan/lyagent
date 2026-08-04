import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerWebAssets(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root, wildcard: false });
  app.get("/qa", async (_request, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
  app.get("/knowledge", async (_request, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
  app.get("/rubrics", async (_request, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
  app.get("/grading", async (_request, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
}
