export function resolveApiPort(environment: NodeJS.ProcessEnv): number {
  const variable = environment.PORT !== undefined
    ? "PORT"
    : environment.COURSE_AGENT_API_PORT !== undefined
      ? "COURSE_AGENT_API_PORT"
      : undefined;
  const rawPort = variable ? environment[variable]! : "3010";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid API port in ${variable ?? "default"}: ${JSON.stringify(rawPort)} must be a decimal integer from 1 to 65535.`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid API port in ${variable ?? "default"}: ${JSON.stringify(rawPort)} must be a decimal integer from 1 to 65535.`);
  }
  return port;
}
