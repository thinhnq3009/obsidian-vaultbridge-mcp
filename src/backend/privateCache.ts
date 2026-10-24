import fs from "node:fs/promises";
import { VaultError } from "../types.js";

/** Only the configured application cache and its vault directory are repaired. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new VaultError("Cache must be an owned directory without symlinks.", { code: "ACCESS_DENIED" });
  }
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
    if (((await fs.stat(directory)).mode & 0o777) !== 0o700) throw new VaultError("Cannot restrict cache permissions.", { code: "ACCESS_DENIED" });
  }
}
