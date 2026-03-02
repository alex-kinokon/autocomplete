/**
 * Map VS Code languageId to tree-sitter grammar WASM filename.
 *
 * Only languages with grammars shipped in `tree-sitter-wasms` are included.
 * The grammar WASMs are built against `tree-sitter-cli@0.20.x` and require
 * a compatible `web-tree-sitter` runtime (currently pinned to `0.25.x`).
 */

import type { LanguageId } from "../context";

/** Map from VS Code languageId to the WASM filename (without extension). */
const LANGUAGE_TO_GRAMMAR = new Map<LanguageId, string>([
  ["typescript", "tree-sitter-typescript"],
  ["typescriptreact", "tree-sitter-tsx"],
  ["javascript", "tree-sitter-javascript"],
  ["javascriptreact", "tree-sitter-javascript"],
  ["python", "tree-sitter-python"],
  ["rust", "tree-sitter-rust"],
  ["go", "tree-sitter-go"],
  ["java", "tree-sitter-java"],
  ["c", "tree-sitter-c"],
  ["cpp", "tree-sitter-cpp"],
  ["csharp", "tree-sitter-c_sharp"],
]);

/**
 * Get the WASM grammar filename for a given VS Code language ID.
 * Returns `undefined` for unsupported languages.
 */
export function getGrammarName(languageId: LanguageId): string | undefined {
  return LANGUAGE_TO_GRAMMAR.get(languageId);
}

/** Check if a language has a tree-sitter grammar available. */
export function isLanguageSupported(languageId: LanguageId): boolean {
  return LANGUAGE_TO_GRAMMAR.has(languageId);
}
