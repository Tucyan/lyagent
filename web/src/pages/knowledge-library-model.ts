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
