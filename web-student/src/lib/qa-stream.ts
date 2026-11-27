import { consumeSse } from "../../../web/src/lib/consume-sse.js";

export async function consumeStudentQaStream(
  response: Response,
  onEvent: Parameters<typeof consumeSse>[1],
  recover: () => Promise<void>,
): ReturnType<typeof consumeSse> {
  const stream = await consumeSse(response, onEvent).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {};
  });
  if (!("terminalEvent" in stream) || !stream.terminalEvent) await recover();
  return stream;
}
