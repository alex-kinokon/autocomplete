/**
 * Map VS Code languageId to tree-sitter grammar WASM filename.
 *
 * Grammar WASMs are pre-built via `scripts/build-tree-sitter.ts` and
 * stored in `src/tree-sitter/wasm/`. The build step copies them to
 * `dist/grammars/` alongside the `web-tree-sitter` runtime WASM.
 */

import type { LanguageId } from "../context";

/** Map from VS Code languageId to the WASM filename (without extension). */
const LANGUAGE_TO_GRAMMAR = new Map<LanguageId, string>([
  ["shellscript", "tree-sitter-bash"],
  ["c", "tree-sitter-c"],
  ["csharp", "tree-sitter-c_sharp"],
  ["cpp", "tree-sitter-cpp"],
  ["css", "tree-sitter-css"],
  ["dart", "tree-sitter-dart"],
  ["go", "tree-sitter-go"],
  ["html", "tree-sitter-html"],
  ["java", "tree-sitter-java"],
  ["javascript", "tree-sitter-javascript"],
  ["javascriptreact", "tree-sitter-javascript"],
  ["json", "tree-sitter-json"],
  ["jsonc", "tree-sitter-json"],
  ["kotlin", "tree-sitter-kotlin"],
  ["lua", "tree-sitter-lua"],
  ["objective-c", "tree-sitter-objc"],
  ["php", "tree-sitter-php"],
  ["python", "tree-sitter-python"],
  ["ruby", "tree-sitter-ruby"],
  ["rust", "tree-sitter-rust"],
  ["scala", "tree-sitter-scala"],
  ["swift", "tree-sitter-swift"],
  ["toml", "tree-sitter-toml"],
  ["typescript", "tree-sitter-typescript"],
  ["typescriptreact", "tree-sitter-tsx"],
  ["yaml", "tree-sitter-yaml"],
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
