/**
 * Import-aware context enrichment.
 *
 * Extracts imported symbol names, finds their references near the cursor,
 * resolves definitions via {@link DefinitionCache}, and creates related
 * snippets with the definition source code.
 */
import * as vscode from "vscode";

import type { LanguageId, RelatedSnippet } from "./context.ts";
import type { DefinitionCache } from "./definition-cache.ts";
import * as log from "./log.ts";

/** Maximum lines of context to extract around a definition location. */
const DEFINITION_SNIPPET_LINES = 15;
/** Maximum number of definitions to resolve per completion request. */
const MAX_DEFINITIONS = 3;
/** Lines before/after cursor to scan for imported identifiers. */
const SCAN_RADIUS = 5;
/** Maximum time (ms) to wait for each definition lookup. */
const LOOKUP_TIMEOUT_MS = 150;

/** An imported symbol name (the local identifier used in code). */
export interface ImportedSymbol {
  name: string;
}

// Imported name extraction

/**
 * Extract imported symbol names from source text.
 *
 * Returns the local names that code in this file would use to reference
 * the imports. Handles aliasing (e.g., `import { a as b }` returns `b`).
 */
export function extractImportedNames(
  text: string,
  languageId: LanguageId
): ImportedSymbol[] {
  const symbols: ImportedSymbol[] = [];

  switch (languageId) {
    case "typescript":
    case "typescriptreact":
    case "javascript":
    case "javascriptreact":
      extractJsImportedNames(text, symbols);
      break;
    case "python":
      extractPythonImportedNames(text, symbols);
      break;
    case "go":
      extractGoImportedNames(text, symbols);
      break;
    case "rust":
      extractRustImportedNames(text, symbols);
      break;
    default:
      break;
  }

  return symbols;
}

function extractJsImportedNames(text: string, out: ImportedSymbol[]): void {
  // Named: import { a, b as c } from "spec" (and import type { ... })
  for (const match of text.matchAll(
    /import\s+(?:type\s+)?{([^}]+)}\s+from\s+["'][^"']+["']/g
  )) {
    for (const name of match[1]!.split(",")) {
      const alias = stripInlineType(name);
      if (alias && /^[$_a-z]/i.test(alias)) {
        out.push({ name: alias });
      }
    }
  }

  // Combined: import Default, { named } from "spec"
  for (const match of text.matchAll(
    /import\s+([$A-Z_a-z][\w$]*)\s*,\s*{([^}]+)}\s+from\s+["'][^"']+["']/g
  )) {
    out.push({ name: match[1]! });
    for (const name of match[2]!.split(",")) {
      const alias = stripInlineType(name);
      if (alias && /^[$_a-z]/i.test(alias)) {
        out.push({ name: alias });
      }
    }
  }

  // Type-only default: import type Foo from "spec"
  for (const match of text.matchAll(
    /import\s+type\s+([$A-Z_a-z][\w$]*)\s+from\s+["'][^"']+["']/g
  )) {
    out.push({ name: match[1]! });
  }

  // Default: import Name from "spec"  (exclude `import type` and combined forms)
  for (const match of text.matchAll(
    /import\s+([$A-Z_a-z][\w$]*)\s+from\s+["'][^"']+["']/g
  )) {
    if (match[1] !== "type") {
      out.push({ name: match[1]! });
    }
  }

  // Namespace: import * as Name from "spec"
  for (const match of text.matchAll(
    /import\s+\*\s+as\s+([$A-Z_a-z][\w$]*)\s+from\s+["'][^"']+["']/g
  )) {
    out.push({ name: match[1]! });
  }

  // CommonJS: const Name = require("spec")
  for (const match of text.matchAll(
    /(?:const|let|var)\s+([$A-Z_a-z][\w$]*)\s*=\s*require\s*\(/g
  )) {
    out.push({ name: match[1]! });
  }

  // Destructured require: const { a, b } = require("spec")
  for (const match of text.matchAll(
    /(?:const|let|var)\s+{([^}]+)}\s*=\s*require\s*\(/g
  )) {
    for (const name of match[1]!.split(",")) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s*:\s*/);
      const alias = (parts.length > 1 ? parts[1]! : parts[0]!).trim();
      if (/^[$_a-z]/i.test(alias)) {
        out.push({ name: alias });
      }
    }
  }
}

function extractPythonImportedNames(text: string, out: ImportedSymbol[]): void {
  // from module import a, b as c
  for (const match of text.matchAll(/from\s+[\w.]+\s+import\s+(.+)/g)) {
    for (const name of match[1]!.split(",")) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const alias = (parts.length > 1 ? parts[1]! : parts[0]!).trim();
      if (/^[_a-z]/i.test(alias)) {
        out.push({ name: alias });
      }
    }
  }

  // import module / import module as alias
  for (const match of text.matchAll(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?$/gm)) {
    const name = match[2] ?? match[1]!.split(".").pop()!;
    out.push({ name });
  }
}

function extractGoImportedNames(text: string, out: ImportedSymbol[]): void {
  // Single: import "pkg" or import alias "pkg"
  for (const match of text.matchAll(/import\s+(?:([\w.]+)\s+)?"([^"]+)"\s*$/gm)) {
    const alias = match[1];
    if (alias === "_" || alias === ".") continue; // blank/dot import
    const name = alias ?? match[2]!.split("/").pop()!;
    out.push({ name });
  }

  // Grouped: import ( ... )
  for (const match of text.matchAll(/import\s*\(([\S\s]*?)\)/g)) {
    for (const line of match[1]!.matchAll(/(?:([\w.]+)\s+)?"([^"]+)"/g)) {
      const alias = line[1];
      if (alias === "_" || alias === ".") continue; // blank/dot import
      const name = alias ?? line[2]!.split("/").pop()!;
      out.push({ name });
    }
  }
}

function extractRustImportedNames(text: string, out: ImportedSymbol[]): void {
  // use path::Name;
  for (const match of text.matchAll(/use\s+[\w:]+::(\w+)\s*;/g)) {
    out.push({ name: match[1]! });
  }

  // use path::{Name1, Name2 as Alias};
  for (const match of text.matchAll(/use\s+[\w:]+::{([^}]+)}\s*;/g)) {
    for (const name of match[1]!.split(",")) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const alias = (parts.length > 1 ? parts[1]! : parts[0]!).trim();
      if (/^[_a-z]/i.test(alias)) {
        out.push({ name: alias });
      }
    }
  }
}

// Identifier scanning

/**
 * Find identifiers near the cursor that match imported symbol names.
 *
 * Scans {@link SCAN_RADIUS} lines above and below the cursor. Returns
 * unique identifiers with their positions, limited to {@link MAX_DEFINITIONS}.
 */
export function findReferencedImports(
  document: vscode.TextDocument,
  position: vscode.Position,
  importedNames: Set<string>,
  languageId?: LanguageId
): Array<{ name: string; position: vscode.Position }> {
  if (importedNames.size === 0) return [];

  const startLine = Math.max(0, position.line - SCAN_RADIUS);
  const endLine = Math.min(document.lineCount - 1, position.line + SCAN_RADIUS);
  const lang = languageId ?? document.languageId;

  const seen = new Set<string>();
  const results: Array<{ name: string; position: vscode.Position }> = [];

  let inBlockComment = false;
  let inTemplateLiteral = false;
  for (let line = startLine; line <= endLine; line++) {
    let text = document.lineAt(line).text;

    // Track multi-line block comment state across lines
    if (inBlockComment) {
      const closeIdx = text.indexOf("*/");
      if (closeIdx !== -1) {
        inBlockComment = false;
        // Blank out comment portion, keep code after close at original offsets
        text = " ".repeat(closeIdx + 2) + text.slice(closeIdx + 2);
      } else {
        continue; // Entire line inside block comment
      }
    }

    // Track multi-line template literal state across lines
    if (inTemplateLiteral) {
      const closeIdx = indexOfUnescaped(text, "`");
      if (closeIdx !== -1) {
        inTemplateLiteral = false;
        // Blank template part preserving interpolation offsets, keep code after close
        text =
          padInterpolations(text.slice(0, closeIdx)) + " " + text.slice(closeIdx + 1);
      } else {
        // Entire line inside template literal. Preserve interpolation offsets
        text = padInterpolations(text);
      }
    }

    // Strip full-line comments to avoid false-positive matches
    const trimmed = text.trimStart();
    if (trimmed.startsWith("//") || (lang === "python" && trimmed.startsWith("#"))) {
      continue;
    }
    // Remove string contents (single-line), preserving template interpolation content.
    // Replace with same-length spaces to keep character offsets valid for LSP lookups.
    text = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m =>
      " ".repeat(m.length)
    );
    text = text.replace(/`[^`]*`/g, m => padInterpolations(m));
    text = text.replace(/\/\*.*?\*\//g, m => " ".repeat(m.length));
    // Check for unclosed block comment opening (multi-line start)
    const openIdx = text.indexOf("/*");
    if (openIdx !== -1) {
      inBlockComment = true;
      text = text.slice(0, openIdx);
    }
    // Check for unclosed template literal (multi-line start)
    const backtickIdx = indexOfUnescaped(text, "`");
    if (backtickIdx !== -1) {
      inTemplateLiteral = true;
      // Blank from backtick onward, preserving interpolation content at original offsets
      text = text.slice(0, backtickIdx) + padInterpolations(text.slice(backtickIdx));
    }
    text = text.replace(/\/\/.*$/, m => " ".repeat(m.length));
    if (lang === "python") {
      text = text.replace(/#.*$/, m => " ".repeat(m.length));
    }
    const identRegex = /\b([$_a-z][\w$]*)\b/gi;
    let match;
    while ((match = identRegex.exec(text)) !== null) {
      const name = match[1]!;
      if (importedNames.has(name) && !seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          position: new vscode.Position(line, match.index),
        });
        if (results.length >= MAX_DEFINITIONS) return results;
      }
    }
  }

  return results;
}

// Definition snippet resolution

/**
 * Resolve definition snippets for imported identifiers near the cursor.
 *
 * Uses {@link DefinitionCache} with a per-lookup timeout to avoid blocking
 * the completion pipeline. Skips self-references, node_modules, and files
 * already included in the context.
 */
export async function getDefinitionSnippets(
  document: vscode.TextDocument,
  position: vscode.Position,
  definitionCache: DefinitionCache,
  existingPaths: Set<string>
): Promise<RelatedSnippet[]> {
  try {
    const text = document.getText();
    const importedSymbols = extractImportedNames(text, document.languageId);
    if (importedSymbols.length === 0) return [];

    const importedNameSet = new Set(importedSymbols.map(s => s.name));
    const referencedImports = findReferencedImports(
      document,
      position,
      importedNameSet,
      document.languageId
    );
    if (referencedImports.length === 0) return [];

    log.debug(
      `Import context: ${referencedImports.length} referenced imports: [${referencedImports.map(r => r.name).join(", ")}]`
    );

    // Look up definitions with per-lookup timeout.
    // The concurrency slot stays held until the LSP call settles (preventing
    // overload), but the caller moves on after LOOKUP_TIMEOUT_MS.
    const lookupResults = await Promise.all(
      referencedImports.map(async ident => {
        const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
        const locations = await withTimeout(
          definitionCache.lookup(document.uri, ident.position, document.version),
          signal
        );
        return { ident, locations };
      })
    );

    // Build snippets from resolved definitions
    const snippets: RelatedSnippet[] = [];

    for (const { ident, locations } of lookupResults) {
      if (!locations || locations.length === 0) continue;

      // Iterate through all returned locations to find the first acceptable one.
      // LSP can return multiple (e.g. .d.ts declaration + source implementation);
      // the first may be in node_modules while a later one is the real source.
      for (const loc of locations) {
        // Skip self-references
        if (loc.uri.toString() === document.uri.toString()) continue;

        const folder = vscode.workspace.getWorkspaceFolder(loc.uri);
        const relativePath = folder
          ? vscode.workspace.asRelativePath(loc.uri, false)
          : loc.uri.fsPath;

        // Skip duplicates and node_modules
        if (existingPaths.has(relativePath)) continue;
        if (relativePath.includes("node_modules")) continue;

        try {
          const defDoc = await vscode.workspace.openTextDocument(loc.uri);
          if (defDoc.lineCount > 10_000) continue;

          const startLine = Math.max(0, loc.range.start.line - 2);
          const endLine = Math.min(
            defDoc.lineCount - 1,
            loc.range.start.line + DEFINITION_SNIPPET_LINES
          );

          const content = defDoc.getText(
            new vscode.Range(
              new vscode.Position(startLine, 0),
              new vscode.Position(endLine, defDoc.lineAt(endLine).text.length)
            )
          );

          if (content.trim()) {
            snippets.push({
              relativePath: `<def:${ident.name}> ${relativePath}`,
              content,
            });
            existingPaths.add(relativePath);
            break; // Found a valid location for this identifier
          }
        } catch (error) {
          log.debug(`Failed to read definition for ${ident.name}: ${String(error)}`);
        }
      }
    }

    log.debug(`Import context: resolved ${snippets.length} definition snippets`);
    return snippets;
  } catch (error) {
    log.debug(`Import context: unexpected error: ${String(error)}`);
    return [];
  }
}

/**
 * Strip inline `type` keyword and resolve alias from a named import segment.
 * E.g., `"type Foo"` → `"Foo"`, `"type Foo as Bar"` → `"Bar"`, `""` → `""`.
 */
function stripInlineType(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return "";
  // Strip inline type specifier: import { type Foo } from "..."
  if (trimmed.startsWith("type ")) {
    trimmed = trimmed.slice(5).trim();
  }
  const parts = trimmed.split(/\s+as\s+/);
  return (parts.length > 1 ? parts[1]! : parts[0]!).trim();
}

/**
 * Replace all characters with spaces except content inside `${...}` interpolations.
 * Returns a string of the same length as the input, preserving character offsets
 * so that `match.index` from a subsequent regex scan corresponds to the original
 * source column.
 */
function padInterpolations(text: string): string {
  const result = new Array<string>(text.length).fill(" ");
  for (const m of text.matchAll(/\${([^}]*)}/g)) {
    const start = m.index + 2; // skip "${"
    const content = m[1]!;
    // eslint-disable-next-line unicorn/no-for-loop -- index-based loop needed for offset arithmetic
    for (let i = 0; i < content.length; i++) {
      result[start + i] = content[i]!;
    }
  }
  return result.join("");
}

/** Find the first unescaped occurrence of `char` in `text`, or -1. */
function indexOfUnescaped(text: string, char: string): number {
  let i = text.indexOf(char);
  while (i > 0) {
    // Count consecutive backslashes preceding the character
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && text[j] === "\\") {
      backslashes++;
      j--;
    }
    // Even backslashes: char is unescaped; odd: char is escaped
    if (backslashes % 2 === 0) return i;
    i = text.indexOf(char, i + 1);
  }
  return i;
}

/** Race a promise against an abort signal, returning `undefined` if the signal fires first. */
async function withTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T | undefined> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
