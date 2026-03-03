/**
 * File exclusion.
 *
 * Blocks completions for files that likely contain secrets (`.env`, private
 * keys, credential configs) and user-configured exclude patterns.
 */
import path from "node:path";

import picomatch from "picomatch";

const SENSITIVE_BASENAMES = new Set([".env", ".npmrc", ".pypirc", ".netrc", ".pgpass"]);
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
]);
const SENSITIVE_DIRS = [".ssh", ".aws", ".gnupg"];

/** Returns `true` if the file path matches a known sensitive pattern or any extra user glob. */
export function isExcludedFile(fsPath: string, extraPatterns?: string[]): boolean {
  const basename = path.basename(fsPath);

  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  if (SENSITIVE_EXTENSIONS.has(path.extname(fsPath))) return true;

  const normalized = fsPath.replaceAll("\\", "/");
  if (SENSITIVE_DIRS.some(d => normalized.includes(`/${d}/`))) return true;

  if (extraPatterns?.length) {
    const isMatch = picomatch(extraPatterns);
    if (isMatch(basename)) return true;
  }

  return false;
}
