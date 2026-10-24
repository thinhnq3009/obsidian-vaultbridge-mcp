/** October 2026 security floors; odd/EOL and untested major lines are rejected. */
export const supportedNodeRange = "^22.23.4 || ^24.22.1";
export function assertSupportedNode(version: string = process.versions.node): void {
  const match = /^(22|24)\.(\d+)\.(\d+)$/u.exec(version);
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const floor = major === 22 ? [23, 4] : [22, 1];
    if (minor > floor[0]! || (minor === floor[0] && patch >= floor[1]!)) return;
  }
  throw new Error(`Unsupported Node.js ${version}. Install a patched release matching ${supportedNodeRange}. See CVE-2026-111497.`);
}
