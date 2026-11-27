import path from "node:path";

const mutationTails = new Map<string, Promise<void>>();

export async function withAssignmentMutation<T>(
  root: string,
  assignmentId: string,
  action: (waited: boolean) => Promise<T>,
): Promise<T> {
  const resolvedRoot = path.resolve(root);
  const key = JSON.stringify(process.platform === "win32"
    ? [resolvedRoot.toLowerCase(), assignmentId.toLowerCase()]
    : [resolvedRoot, assignmentId]);
  const waited = mutationTails.has(key);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  mutationTails.set(key, tail);
  await previous;
  try {
    return await action(waited);
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}
