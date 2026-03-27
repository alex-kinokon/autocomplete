/**
 * Document context extraction for completion requests.
 *
 * Gathers the code before/after the cursor and snippets from other visible
 * editors to provide cross-file context to the model.
 */
import * as vscode from "vscode";

import type { DefinitionCache } from "./definition-cache.ts";
import type { EditTracker, FileEditHistory } from "./edit-tracker.ts";
import { isExcludedFile } from "./exclude-file.ts";
import { getDefinitionSnippets } from "./import-context.ts";
import * as log from "./log.ts";
import type { SymbolCache } from "./symbol-cache.ts";
import type { ParserPool } from "./tree-sitter/parser-pool.ts";
import { formatRootPathContext, getRootPath } from "./tree-sitter/root-path.ts";
import { findPrefixBoundary, findSuffixBoundary } from "./tree-sitter/truncation.ts";

const MAX_SNIPPET_FILES = 5;
const MAX_SNIPPET_LINES = 30;

// https://code.visualstudio.com/docs/languages/identifiers#_known-language-identifiers
export type LanguageId =
  | (string & {})
  | "bat"
  | "bibtex"
  | "c"
  | "chatagent"
  | "clojure"
  | "code-text-binary"
  | "coffeescript"
  | "cpp"
  | "csharp"
  | "css"
  | "cuda-cpp"
  | "dart"
  | "diff"
  | "dockercompose"
  | "dockerfile"
  | "dotenv"
  | "fsharp"
  | "git-commit"
  | "git-rebase"
  | "go"
  | "groovy"
  | "handlebars"
  | "hlsl"
  | "html"
  | "ignore"
  | "ini"
  | "instructions"
  | "jade"
  | "java"
  | "javascript"
  | "javascriptreact"
  | "json"
  | "jsonc"
  | "jsonl"
  | "julia"
  | "juliamarkdown"
  | "latex"
  | "less"
  | "log"
  | "lua"
  | "makefile"
  | "markdown"
  | "objective-c"
  | "objective-cpp"
  | "perl"
  | "php"
  | "plaintext"
  | "powershell"
  | "prompt"
  | "properties"
  | "python"
  | "r"
  | "raku"
  | "razor"
  | "restructuredtext"
  | "ruby"
  | "rust"
  | "scminput"
  | "scss"
  | "search-result"
  | "shaderlab"
  | "shellscript"
  | "skill"
  | "snippets"
  | "sql"
  | "swift"
  | "tex"
  | "typescript"
  | "typescriptreact"
  | "vb"
  | "wat"
  | "xml"
  | "xsl"
  | "yaml";

/** A snippet of code from another open file, used as cross-file context. */
export interface RelatedSnippet {
  readonly relativePath: string;
  readonly content: string;
}

/** Everything the completion API needs to know about the cursor position. */
export interface DocumentContext {
  /** Code before the cursor. */
  readonly prefix: string;
  /** Code after the cursor. */
  readonly suffix: string;
  readonly languageId: LanguageId;
  /** Workspace-relative file path (e.g. `src/index.ts`). */
  readonly relativePath: string;
  /** Snippets from other visible editors for cross-file context. */
  readonly relatedSnippets: readonly RelatedSnippet[];
}

/** Optional services for richer context extraction. */
export interface ContextOptions {
  readonly editTracker?: EditTracker;
  readonly parserPool?: ParserPool;
  readonly definitionCache?: DefinitionCache;
  readonly symbolCache?: SymbolCache;
}

/**
 * Compute the start and end lines for the context window around the cursor.
 *
 * Uses a nominal 60/40 prefix/suffix split. When the cursor is near a file
 * boundary (e.g. near EOF), unused budget on the constrained side is
 * redistributed to the other side so no context capacity is wasted.
 *
 * Note: the cursor line itself is included in the window beyond the nominal
 * budget, so the actual span (`endLine - startLine + 1`) may exceed
 * `contextLines` by one. This matches the original line-based windowing
 * behavior and is absorbed by the token budget.
 *
 * @param contextLines Total line budget (must be >= 0)
 * @param cursorLine Zero-based cursor line
 * @param lineCount Total lines in the document (must be >= 1)
 */
export function computeContextWindow(
  contextLines: number,
  cursorLine: number,
  lineCount: number
): { startLine: number; endLine: number } {
  if (lineCount <= 0) return { startLine: 0, endLine: 0 };

  const nominalPrefix = Math.round(contextLines * 0.6);
  const nominalSuffix = contextLines - nominalPrefix;

  // How many lines are actually available on each side?
  const availablePrefix = cursorLine;
  const availableSuffix = lineCount - 1 - cursorLine;

  // Redistribute unused budget from the constrained side to the other
  const prefixLines =
    Math.min(availablePrefix, nominalPrefix) +
    Math.max(0, nominalSuffix - availableSuffix);
  const suffixLines =
    Math.min(availableSuffix, nominalSuffix) +
    Math.max(0, nominalPrefix - availablePrefix);

  return {
    startLine: Math.max(0, cursorLine - prefixLines),
    endLine: Math.min(lineCount - 1, cursorLine + suffixLines),
  };
}

/**
 * Extract document context around the cursor.
 *
 * Uses an asymmetric budget (60% prefix, 40% suffix) with dynamic
 * rebalancing when the cursor is near a file boundary. More suffix gives
 * the model better awareness of where to "land" the completion.
 *
 * When a ParserPool is available, adjusts boundaries to AST statement
 * boundaries and includes root-path scope context. Falls back to
 * SymbolCache for scope context when tree-sitter grammars are unavailable.
 *
 * When a DefinitionCache is provided, resolves imported symbol definitions
 * and includes them as related snippets.
 */
export async function extractContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  contextLines: number,
  options?: ContextOptions
): Promise<DocumentContext> {
  const { editTracker, parserPool, definitionCache, symbolCache } = options ?? {};
  const { startLine: computedStart, endLine: computedEnd } = computeContextWindow(
    contextLines,
    position.line,
    document.lineCount
  );

  let startLine = computedStart;
  let endLine = computedEnd;

  // When parser available, adjust boundaries to AST boundaries
  let rootPathSnippet: RelatedSnippet | undefined;
  if (parserPool) {
    try {
      const fullText = document.getText();
      const tree = await parserPool.parse(fullText, document.languageId);
      if (tree) {
        try {
          startLine = Math.min(findPrefixBoundary(tree, startLine), position.line);
          endLine = Math.max(findSuffixBoundary(tree, endLine), position.line);

          // Extract root-path context (pass split lines to avoid O(node) text materialization)
          const sourceLines = fullText.split("\n");
          const rootPath = getRootPath(
            tree,
            position.line,
            position.character,
            sourceLines
          );
          if (rootPath.length > 0) {
            const content = formatRootPathContext(rootPath);
            if (content) {
              rootPathSnippet = { relativePath: "<scope>", content };
            }
          }
        } finally {
          tree.delete();
        }
      }
    } catch (error) {
      log.debug(
        `Tree-sitter context extraction failed, using line-based fallback: ${String(error)}`
      );
    }
  }

  const prefix = document.getText(
    new vscode.Range(new vscode.Position(startLine, 0), position)
  );
  // Guarantee non-empty suffix: Ollama’s Go template treats "" as falsy,
  // which skips FIM templating and falls back to chat mode.
  const suffix =
    document.getText(
      new vscode.Range(
        position,
        new vscode.Position(endLine, document.lineAt(endLine).text.length)
      )
    ) || "\n";

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const relativePath = folder
    ? vscode.workspace.asRelativePath(document.uri, false)
    : document.fileName;

  const relatedSnippets = await gatherRelatedSnippets(document, editTracker);

  // Symbol-based scope context fallback (for languages without tree-sitter)
  if (!rootPathSnippet && symbolCache) {
    const symbols = symbolCache.getCached(document.uri, document.version);
    if (symbols) {
      const path = symbolCache.getEnclosingSymbolPath(symbols, position);
      if (path.length > 0) {
        const content = formatSymbolPathContext(path);
        if (content) {
          rootPathSnippet = { relativePath: "<scope>", content };
        }
      }
    } else {
      // Warm cache for next completion (fire-and-forget)
      void symbolCache.getSymbols(document.uri, document.version);
    }
  }

  // Prepend root-path / scope context as a synthetic snippet
  if (rootPathSnippet) {
    relatedSnippets.unshift(rootPathSnippet);
  }

  // Resolve imported symbol definitions as additional snippets
  if (definitionCache) {
    const existingPaths = new Set(relatedSnippets.map(s => s.relativePath));
    const defSnippets = await getDefinitionSnippets(
      document,
      position,
      definitionCache,
      existingPaths
    );
    relatedSnippets.push(...defSnippets);
  }

  return {
    prefix,
    suffix,
    languageId: document.languageId,
    relativePath,
    relatedSnippets,
  };
}

// Snippet scoring weights
const SCORE_IMPORT_MATCH = 10;
const SCORE_RECENTLY_EDITED = 8;
const SCORE_VISIBLE = 3;
const EDIT_RANGE_PADDING = 3;

/** Candidate file for snippet selection with a relevance score. */
interface SnippetCandidate {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  score: number;
  /** For visible editors: the editor reference for content extraction. */
  editor?: vscode.TextEditor;
  /** For recently-edited files: the edit history. */
  editHistory?: FileEditHistory;
}

/**
 * Collect code snippets from related files, ranked by relevance.
 *
 * Scores candidates: +10 import match, +8 recently edited, +3 visible.
 * Takes top {@link MAX_SNIPPET_FILES} by score.
 */
async function gatherRelatedSnippets(
  currentDocument: vscode.TextDocument,
  editTracker?: EditTracker
): Promise<RelatedSnippet[]> {
  const currentUri = currentDocument.uri.toString();
  const imports = extractImports(currentDocument.getText(), currentDocument.languageId);

  // Build candidate map
  const candidates = new Map<string, SnippetCandidate>();

  // Score visible editors
  for (const editor of vscode.window.visibleTextEditors) {
    const { document } = editor;
    if (document.uri.scheme !== "file") continue;
    if (isExcludedFile(document.uri.fsPath)) continue;
    const uri = document.uri.toString();
    if (uri === currentUri) continue;

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const relativePath = folder
      ? vscode.workspace.asRelativePath(document.uri, false)
      : document.fileName;

    const existing = candidates.get(uri);
    if (existing) {
      existing.score += SCORE_VISIBLE;
      existing.editor = editor;
    } else {
      candidates.set(uri, {
        uri: document.uri,
        relativePath,
        score: SCORE_VISIBLE,
        editor,
      });
    }
  }

  // Score recently-edited files
  if (editTracker) {
    for (const history of editTracker.getRecentlyEditedFiles(currentDocument.uri)) {
      if (isExcludedFile(history.uri.fsPath)) continue;
      const uri = history.uri.toString();
      if (uri === currentUri) continue;

      const existing = candidates.get(uri);
      if (existing) {
        existing.score += SCORE_RECENTLY_EDITED;
        existing.editHistory = history;
      } else {
        const folder = vscode.workspace.getWorkspaceFolder(history.uri);
        const relativePath = folder
          ? vscode.workspace.asRelativePath(history.uri, false)
          : history.uri.fsPath;

        candidates.set(uri, {
          uri: history.uri,
          relativePath,
          score: SCORE_RECENTLY_EDITED,
          editHistory: history,
        });
      }
    }
  }

  // Boost import matches
  if (imports.length > 0) {
    const currentFolder = vscode.workspace.getWorkspaceFolder(currentDocument.uri);
    const currentRelativePath = currentFolder
      ? vscode.workspace.asRelativePath(currentDocument.uri, false)
      : currentDocument.fileName;
    for (const candidate of candidates.values()) {
      if (isImportMatch(candidate.relativePath, imports, currentRelativePath)) {
        candidate.score += SCORE_IMPORT_MATCH;
      }
    }
  }

  // Sort by score descending, take top N
  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SNIPPET_FILES);

  // Extract content from each candidate
  const snippets: RelatedSnippet[] = [];
  for (const candidate of ranked) {
    const content = await extractCandidateContent(candidate);
    if (content?.trim()) {
      snippets.push({ relativePath: candidate.relativePath, content });
    }
  }

  return snippets;
}

/** Extract the best content from a snippet candidate. */
async function extractCandidateContent(
  candidate: SnippetCandidate
): Promise<string | undefined> {
  // Prefer edited ranges (with padding) when available and editor is open
  if (candidate.editHistory && candidate.editor) {
    return extractEditedRanges(candidate.editor.document, candidate.editHistory);
  }

  // Edit history without a visible editor. Open the document to read it.
  if (candidate.editHistory) {
    try {
      const doc = await vscode.workspace.openTextDocument(candidate.uri);
      return extractEditedRanges(doc, candidate.editHistory);
    } catch {
      return;
    }
  }

  // Fall back to visible range
  if (candidate.editor) {
    return extractVisibleRange(candidate.editor);
  }

  return;
}

/** Extract content around recently-edited ranges with padding. */
export function extractEditedRanges(
  document: vscode.TextDocument,
  history: FileEditHistory
): string {
  // Merge overlapping ranges
  const ranges = history.edits
    .map(e => ({
      start: Math.max(0, e.startLine - EDIT_RANGE_PADDING),
      end: Math.min(document.lineCount - 1, e.endLine + EDIT_RANGE_PADDING),
    }))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  // Cap total lines, clipping the last range to fit the budget
  const parts: string[] = [];
  let totalLines = 0;
  for (const range of merged) {
    const remaining = MAX_SNIPPET_LINES - totalLines;
    if (remaining <= 0) break;
    const lines = range.end - range.start + 1;
    if (lines > remaining) {
      range.end = range.start + remaining - 1;
    }
    totalLines += Math.min(lines, remaining);

    parts.push(
      document.getText(
        new vscode.Range(
          new vscode.Position(range.start, 0),
          new vscode.Position(range.end, document.lineAt(range.end).text.length)
        )
      )
    );
  }

  // eslint-disable-next-line unicorn/string-content
  return parts.join("\n...\n");
}

/** Extract visible range content from an editor. */
function extractVisibleRange(editor: vscode.TextEditor): string {
  const { document, visibleRanges } = editor;
  const range = visibleRanges[0];
  const startLine = range ? range.start.line : 0;
  const endLine = Math.min(
    range ? range.end.line : MAX_SNIPPET_LINES - 1,
    startLine + MAX_SNIPPET_LINES - 1,
    document.lineCount - 1
  );

  return document.getText(
    new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    )
  );
}

/**
 * Check if a file path matches any of the extracted import specifiers.
 *
 * When {@link currentFilePath} is provided, relative imports are resolved
 * against the importing file’s directory for an exact match. Without it,
 * falls back to suffix-based matching.
 */
export function isImportMatch(
  relativePath: string,
  imports: readonly string[],
  currentFilePath?: string
): boolean {
  // Normalize: POSIX separators, remove extension and leading ./
  const normalized = relativePath
    .replaceAll("\\", "/")
    .replace(/\.[^.]+$/, "")
    .replace(/^\.\//, "");

  // Only match relative imports (./foo, ../bar). Bare specifiers like "react"
  // or "lodash" are npm packages and should not boost local workspace files.
  const relativeImports = imports.filter(
    imp => imp.startsWith("./") || imp.startsWith("../")
  );

  if (currentFilePath) {
    const currentDir = currentFilePath.replaceAll("\\", "/").replace(/\/[^/]+$/, "");
    return relativeImports.some(imp => {
      const resolved = resolveRelativePath(currentDir, imp).replace(/\.[^.]+$/, "");
      return normalized === resolved;
    });
  }

  return relativeImports.some(imp => {
    // Strip relative prefix first, then extension (reversed order avoids
    // the extension regex treating the "." in "./" as an extension dot).
    const normalizedImport = imp.replace(/^(?:\.\.?\/)+/, "").replace(/\.[^.]+$/, "");
    return (
      endsWithSegment(normalized, normalizedImport) ||
      endsWithSegment(normalizedImport, normalized)
    );
  });
}

/** Resolve a relative import path against a directory. */
function resolveRelativePath(dir: string, importPath: string): string {
  const parts = dir.split("/");
  for (const segment of importPath.split("/")) {
    if (segment === ".") continue;
    else if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Check if `haystack` ends with `needle` at a path segment boundary. */
function endsWithSegment(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  return haystack.endsWith("/" + needle);
}

/**
 * Extract import specifiers from source text.
 *
 * Supports ES imports, CommonJS requires, Python imports, and Go imports.
 * Returns the raw specifier strings (e.g. `"./utils"`, `"os"`).
 */
export function extractImports(text: string, languageId: LanguageId): string[] {
  const imports: string[] = [];

  switch (languageId) {
    case "typescript":
    case "typescriptreact":
    case "javascript":
    case "javascriptreact":
      // ES imports: import ... from "specifier" (supports multiline)
      for (const match of text.matchAll(
        /(?:import|export)\b[^"']+\bfrom\s+["']([^"']+)["']/g
      )) {
        imports.push(match[1]!);
      }
      // Side-effect imports: import "specifier"
      for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']\s*;?$/gm)) {
        imports.push(match[1]!);
      }
      // CommonJS: require("specifier")
      for (const match of text.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        imports.push(match[1]!);
      }
      break;

    case "python":
      // from module import ... / import module
      for (const match of text.matchAll(/(?:from|import)\s+([\w.]+)/g)) {
        imports.push(match[1]!);
      }
      break;

    case "go":
      // import "pkg" or import ( "pkg1" "pkg2" )
      for (const match of text.matchAll(/import\s+(?:\w+\s+)?"([^"]+)"/g)) {
        imports.push(match[1]!);
      }
      for (const match of text.matchAll(/import\s*\(([\S\s]*?)\)/g)) {
        for (const pkg of match[1]!.matchAll(/(?:\w+\s+)?"([^"]+)"/g)) {
          imports.push(pkg[1]!);
        }
      }
      break;
  }

  return imports;
}

const COMMENT_PREFIXES = new Map<string, string>([
  ["python", "#"],
  ["ruby", "#"],
  ["shellscript", "#"],
  ["yaml", "#"],
  ["perl", "#"],
  ["coffeescript", "#"],
  ["r", "#"],
  ["julia", "#"],
  ["elixir", "#"],
  ["powershell", "#"],
  ["makefile", "#"],
  ["toml", "#"],
  ["dockerfile", "#"],

  ["lua", "--"],
  ["sql", "--"],
  ["haskell", "--"],

  ["matlab", "%"],
  ["erlang", "%"],

  ["clojure", ";"],
  ["lisp", ";"],
  ["scheme", ";"],

  ["html", "<!--"],
  ["xml", "<!--"],

  ["css", "/*"],
  ["scss", "//"],
  ["less", "//"],
]);

/** Language IDs that represent prose rather than code. */
const PROSE_LANGUAGES = new Set<string>(["scminput", "git-commit"]);

/** Check whether a language ID represents prose (e.g. commit messages). */
export function isProseLanguage(languageId: LanguageId): boolean {
  return PROSE_LANGUAGES.has(languageId);
}

/** Return the line comment prefix for a given language. */
export function commentPrefix(languageId: LanguageId): string {
  if (PROSE_LANGUAGES.has(languageId)) return "";
  return COMMENT_PREFIXES.get(languageId) ?? "//";
}

// Symbol-based scope context (fallback for tree-sitter root-path)
const SYMBOL_KIND_LABELS = new Map<number, string>([
  [2, "module"],
  [3, "namespace"],
  [5, "class"],
  [6, "method"],
  [10, "enum"],
  [11, "interface"],
  [12, "function"],
  [23, "struct"],
]);

/**
 * Format an enclosing symbol path as scope context, mimicking the
 * tree-sitter root-path format.
 *
 * Returns plain text. Comment wrapping is applied by the caller.
 *
 * @param symbols Symbol path from outermost to innermost
 */
export function formatSymbolPathContext(
  symbols: readonly vscode.DocumentSymbol[]
): string {
  if (symbols.length === 0) return "";

  let result = "Scope:\n";
  for (const [i, symbol] of symbols.entries()) {
    const indent = "  ".repeat(i + 1);
    const kind = SYMBOL_KIND_LABELS.get(symbol.kind) ?? "";
    const name = symbol.name;
    const detail = symbol.detail ? ` ${symbol.detail}` : "";
    const label = kind ? `${kind} ${name}${detail}` : `${name}${detail}`;
    result += `${indent}${label}\n`;
  }
  return result;
}
