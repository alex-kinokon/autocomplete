/**
 * Syntax-aware completion validation.
 *
 * Parses `prefix + completion + suffix` and checks for ERROR nodes in the
 * completion region. Uses binary search to find the last valid line.
 */
import type TreeSitter from "web-tree-sitter";

import type { LanguageId } from "../context.ts";
import * as log from "../log.ts";

import type { ParserPool } from "./parser-pool.ts";

/**
 * Validate a completion by parsing it in context.
 *
 * Parses `prefix + completion + suffix` and checks for syntax errors in the
 * completion region. If errors are found, binary-searches for the longest
 * valid prefix of the completion (at line granularity).
 *
 * Returns the (potentially truncated) completion, or the original if:
 * - The parser is unavailable for this language
 * - The completion is already syntactically valid
 * - No valid truncation point exists (single-line or all-or-nothing errors)
 *
 * @param parserPool Parser pool for WASM-based parsing
 * @param prefix Document text before the completion
 * @param completion The raw completion to validate
 * @param suffix Document text after the completion
 * @param languageId VS Code language ID for grammar selection
 */
export async function validateCompletion(
  parserPool: ParserPool,
  prefix: string,
  completion: string,
  suffix: string,
  languageId: LanguageId
): Promise<string> {
  const fullText = prefix + completion + suffix;
  const tree = await parserPool.parse(fullText, languageId);
  if (!tree) return completion;

  try {
    // tree-sitter startIndex/endIndex are UTF-8 byte offsets, not UTF-16
    // code units. Use Buffer.byteLength to convert correctly for non-ASCII.
    const prefixLength = Buffer.byteLength(prefix, "utf8");
    const completionEnd = prefixLength + Buffer.byteLength(completion, "utf8");

    // Check if the completion region contains errors
    if (!hasErrorInRange(tree.rootNode, prefixLength, completionEnd)) {
      return completion;
    }

    log.debug("Completion contains syntax errors, searching for valid prefix");

    // Binary search for the longest valid completion prefix
    return binarySearchValidCompletion(
      parserPool,
      prefix,
      completion,
      suffix,
      languageId
    );
  } finally {
    tree.delete();
  }
}

/**
 * Check if any ERROR or MISSING nodes overlap the given byte range.
 *
 * ERROR nodes are explicit parse failures; MISSING nodes are tokens the
 * parser inserted during error recovery (e.g. a missing closing paren).
 */
function hasErrorInRange(
  root: TreeSitter.Node,
  startByte: number,
  endByte: number
): boolean {
  const errors = root.descendantsOfType("ERROR");
  for (const error of errors) {
    if (!error) continue;
    // Check if error overlaps with the range
    if (error.startIndex < endByte && error.endIndex > startByte) {
      return true;
    }
  }

  // Also check for MISSING nodes in the range
  return hasMissingInRange(root, startByte, endByte);
}

/**
 * Check for MISSING nodes (parser-inserted recovery nodes) in a range.
 */
function hasMissingInRange(
  node: TreeSitter.Node,
  startByte: number,
  endByte: number
): boolean {
  if (node.endIndex < startByte || node.startIndex > endByte) {
    return false;
  }

  if (node.isMissing && node.startIndex >= startByte && node.startIndex < endByte) {
    return true;
  }

  for (const child of node.children) {
    if (child && hasMissingInRange(child, startByte, endByte)) {
      return true;
    }
  }

  return false;
}

/**
 * Binary search for the longest prefix of `completion` that doesn’t introduce
 * syntax errors when placed between `prefix` and `suffix`.
 *
 * Operates at line granularity. Each iteration re-parses the full document
 * with a candidate subset of completion lines. O(log(lines) * parse_time).
 */
async function binarySearchValidCompletion(
  parserPool: ParserPool,
  prefix: string,
  completion: string,
  suffix: string,
  languageId: LanguageId
): Promise<string> {
  // Split completion into lines for line-granularity binary search
  const lines = completion.split("\n");
  if (lines.length <= 1) return ""; // Single-line invalid → reject entirely

  let lo = 0;
  let hi = lines.length;
  let lastValid = 0;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = lines.slice(0, mid + 1).join("\n");
    const fullText = prefix + candidate + suffix;

    const tree = await parserPool.parse(fullText, languageId);
    if (!tree) {
      // Parser failed mid-search. Return best valid prefix found so far
      // (not the original completion, which is already known to be invalid).
      if (lastValid === 0) return "";
      return lines.slice(0, lastValid).join("\n");
    }

    try {
      const prefixLen = Buffer.byteLength(prefix, "utf8");
      const candidateEnd = prefixLen + Buffer.byteLength(candidate, "utf8");

      if (!hasErrorInRange(tree.rootNode, prefixLen, candidateEnd)) {
        lastValid = mid + 1;
        lo = mid + 1;
      } else {
        hi = mid;
      }
    } finally {
      tree.delete();
    }
  }

  if (lastValid === 0) return ""; // No valid prefix found, reject entirely
  if (lastValid >= lines.length) return completion;

  const truncated = lines.slice(0, lastValid).join("\n");
  log.debug(`Truncated completion from ${lines.length} to ${lastValid} lines`);
  return truncated;
}
