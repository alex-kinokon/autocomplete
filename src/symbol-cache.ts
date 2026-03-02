/**
 * Document symbol cache.
 *
 * Wraps `vscode.executeDocumentSymbolProvider` with version-based
 * invalidation and request coalescing. Provides enclosing symbol path
 * lookup as a fallback for tree-sitter root-path in languages without
 * tree-sitter grammars.
 */
import { LRUCache } from "lru-cache";
import * as vscode from "vscode";

import * as log from "./log.ts";

interface CacheEntry {
  readonly symbols: vscode.DocumentSymbol[];
  readonly documentVersion: number;
}

/** Symbol kinds that represent meaningful scope boundaries. */
const SCOPE_SYMBOL_KINDS = new Set([
  2, // Module
  3, // Namespace
  5, // Class
  6, // Method
  10, // Enum
  11, // Interface
  12, // Function
  23, // Struct
]);

export class SymbolCache implements vscode.Disposable {
  private readonly cache = new LRUCache<string, CacheEntry>({
    max: 50,
    ttl: 30_000,
  });
  private readonly pending = new Map<
    string,
    { promise: Promise<vscode.DocumentSymbol[] | undefined>; version: number }
  >();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme === "file") {
        this.cache.delete(event.document.uri.toString());
      }
    });
  }

  dispose(): void {
    this.disposable.dispose();
    this.cache.clear();
    this.pending.clear();
  }

  /**
   * Get document symbols, using cache when possible.
   * Makes an LSP call on cache miss.
   */
  async getSymbols(
    uri: vscode.Uri,
    documentVersion: number
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    const key = uri.toString();

    const cached = this.cache.get(key);
    if (cached && cached.documentVersion === documentVersion) {
      return cached.symbols;
    }

    // Coalesce with in-flight request for same version
    const existing = this.pending.get(key);
    if (existing && existing.version === documentVersion) return existing.promise;

    const promise = this.executeAndCache(key, uri, documentVersion);
    this.pending.set(key, { promise, version: documentVersion });
    return promise;
  }

  /**
   * Check cache only and no LSP call. For use in the hot completion path.
   */
  getCached(
    uri: vscode.Uri,
    documentVersion: number
  ): vscode.DocumentSymbol[] | undefined {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.documentVersion === documentVersion) {
      return cached.symbols;
    }
    return;
  }

  /**
   * Find the chain of enclosing scope symbols from outermost to innermost.
   *
   * Only includes symbols whose kind is in {@link SCOPE_SYMBOL_KINDS}
   * (functions, classes, methods, etc.).
   */
  getEnclosingSymbolPath(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position
  ): vscode.DocumentSymbol[] {
    const path: vscode.DocumentSymbol[] = [];
    this.walkSymbols(symbols, position, path);
    return path;
  }

  private walkSymbols(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position,
    path: vscode.DocumentSymbol[]
  ): boolean {
    for (const symbol of symbols) {
      if (symbol.range.contains(position)) {
        // Only add scope kinds to the path, but always descend into
        // children. A non-scope container (e.g. Variable) may hold
        // nested scope symbols (e.g. Function).
        if (SCOPE_SYMBOL_KINDS.has(symbol.kind)) {
          path.push(symbol);
        }
        this.walkSymbols(symbol.children, position, path);
        return true;
      }
    }
    return false;
  }

  private async executeAndCache(
    key: string,
    uri: vscode.Uri,
    documentVersion: number
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    try {
      // Provider may return DocumentSymbol[] (hierarchical) or SymbolInformation[]
      // (flat, legacy) or undefined/null.
      // @see {vscode.DocumentSymbolProvider.provideDocumentSymbols}
      const result = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
      >("vscode.executeDocumentSymbolProvider", uri);

      const symbols = normalizeSymbols(result);
      this.cache.set(key, { symbols, documentVersion });
      log.debug(`Symbol cache: stored ${symbols.length} symbols for ${key}`);
      return symbols;
    } catch (error) {
      log.error("Symbol lookup failed", String(error));
      return;
    } finally {
      const entry = this.pending.get(key);
      if (entry?.version === documentVersion) {
        this.pending.delete(key);
      }
    }
  }
}

/** Type guard: `SymbolInformation` has `location`, `DocumentSymbol` has `range`. */
function isSymbolInformation(
  sym: vscode.DocumentSymbol | vscode.SymbolInformation
): sym is vscode.SymbolInformation {
  return "location" in sym;
}

/**
 * Normalize provider results to `DocumentSymbol[]`.
 *
 * Modern language servers return hierarchical `DocumentSymbol[]`. Legacy
 * servers return flat `SymbolInformation[]` (with `location.range` instead
 * of `range`, and no `children`). This converts the latter into
 * `DocumentSymbol`-shaped objects so consumers don’t need to branch.
 * @see {vscode.DocumentSymbolProvider.provideDocumentSymbols}
 */
function normalizeSymbols(
  result: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | null | undefined
): vscode.DocumentSymbol[] {
  if (!result || result.length === 0) return [];

  // Check first element to determine the shape
  if (!isSymbolInformation(result[0]!)) {
    return result as vscode.DocumentSymbol[];
  }

  // Convert SymbolInformation[] → DocumentSymbol[] with hierarchy rebuilt
  // from range containment.
  const flat = (result as vscode.SymbolInformation[]).map(sym => ({
    name: sym.name,
    detail: "",
    kind: sym.kind,
    tags: sym.tags ? [...sym.tags] : [],
    range: sym.location.range,
    selectionRange: sym.location.range,
    children: [] as vscode.DocumentSymbol[],
  })) as vscode.DocumentSymbol[];

  return buildHierarchy(flat);
}

/**
 * Build a hierarchy from a flat list of symbols using range containment.
 *
 * Sorts symbols largest-range-first so that potential parents are processed
 * before their children. Each symbol is placed under the smallest existing
 * symbol whose range fully contains it.
 */
function buildHierarchy(flat: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  // Sort: larger ranges first; ties broken by earlier start position
  const sorted = [...flat].sort((a, b) => {
    const aLines = a.range.end.line - a.range.start.line;
    const bLines = b.range.end.line - b.range.start.line;
    if (aLines !== bLines) return bLines - aLines;
    return a.range.start.line - b.range.start.line;
  });

  const roots: vscode.DocumentSymbol[] = [];
  for (const symbol of sorted) {
    const parent = findSmallestContainer(roots, symbol.range);
    if (parent) {
      parent.children.push(symbol);
    } else {
      roots.push(symbol);
    }
  }
  return roots;
}

/** Find the smallest symbol in `tree` whose range fully contains `range`. */
function findSmallestContainer(
  symbols: vscode.DocumentSymbol[],
  range: vscode.Range
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.range.contains(range) && !symbol.range.isEqual(range)) {
      // Descend into children for a tighter fit
      return findSmallestContainer(symbol.children, range) ?? symbol;
    }
  }
  return;
}
