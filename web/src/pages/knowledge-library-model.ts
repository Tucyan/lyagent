export interface VersionableRelease {
  id: string;
  createdAt: string;
}

export function numberReleases<T extends VersionableRelease>(releases: readonly T[]): Array<T & { versionNumber: number; versionLabel: string }> {
  return releases.map((release, index) => {
    const versionNumber = releases.length - index;
    return { ...release, versionNumber, versionLabel: `v${versionNumber}` };
  });
}

export function previewRepeatsTitle(markdown: string, title: string | undefined): boolean {
  if (!title) return false;
  const heading = /^\uFEFF?(?:[ \t]*\r?\n)* {0,3}#{1,6}[ \t]+([^\r\n]+)/.exec(markdown)?.[1];
  return heading?.replace(/[ \t]+#+[ \t]*$/, "").trim() === title.trim();
}
