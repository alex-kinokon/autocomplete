/**
 * Tree-sitter parser pool with lazy WASM initialization and grammar caching.
 *
 * Manages parser lifecycle to avoid WASM memory leaks:
 * - One shared parser instance per language
 * - `tree.delete()` in try/finally to free WASM memory
 * - Lazy initialization on first use (not during extension activation)
 */
import * as vscode from "vscode";
import type TreeSitter from "web-tree-sitter";

import type { LanguageId } from "../context.ts";
import * as log from "../log.ts";

import { getGrammarName } from "./languages.ts";

export class ParserPool implements vscode.Disposable {
  /** In-flight init to coalesce concurrent `ensureInit()` calls. */
  private initPromise: Promise<void> | undefined;
  /** The `web-tree-sitter` module, set after WASM init succeeds. */
  private mod: typeof TreeSitter | undefined;
  /** Cached Language objects keyed by grammar name (e.g. `"tree-sitter-typescript"`). */
  private readonly languages = new Map<string, TreeSitter.Language>();
  /** One shared Parser per grammar reused across `parse()` calls. */
  private readonly parsers = new Map<string, TreeSitter.Parser>();
  private readonly extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  dispose(): void {
    for (const parser of this.parsers.values()) {
      parser.delete();
    }
    this.parsers.clear();
    this.languages.clear();
  }

  /**
   * Parse a document and return the tree. Caller MUST call `tree.delete()`
   * when done to avoid WASM memory leaks.
   *
   * Returns `undefined` if the language is unsupported or parsing fails.
   */
  async parse(
    text: string,
    languageId: LanguageId
  ): Promise<TreeSitter.Tree | undefined> {
    const parser = await this.getParser(languageId);
    if (!parser) return;

    try {
      return parser.parse(text) ?? undefined;
    } catch (error) {
      log.error(`Tree-sitter parse failed for ${languageId}`, error);
      return;
    }
  }

  /** Get or create a parser for the given language. */
  private async getParser(
    languageId: LanguageId
  ): Promise<TreeSitter.Parser | undefined> {
    const grammarName = getGrammarName(languageId);
    if (!grammarName) return;

    // Return cached parser
    const cached = this.parsers.get(grammarName);
    if (cached) return cached;

    // Initialize WASM module on first use
    await this.ensureInit();
    if (!this.mod) return;

    // Re-check after async boundary. A concurrent call may have created
    // the parser while we were awaiting init/load.
    const raced = this.parsers.get(grammarName);
    if (raced) return raced;

    // Load language
    const language = await this.loadLanguage(grammarName);
    if (!language) return;

    // Final re-check after second async boundary
    const raced2 = this.parsers.get(grammarName);
    if (raced2) return raced2;

    // Create parser
    const parser = new this.mod.Parser();
    parser.setLanguage(language);
    this.parsers.set(grammarName, parser);
    return parser;
  }

  /** Initialize the tree-sitter WASM module (once). */
  private async ensureInit(): Promise<void> {
    if (this.mod) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      try {
        const mod = await import("web-tree-sitter");
        // Emscripten looks for `tree-sitter.wasm` next to the JS file.
        // Since esbuild bundles into dist/, we use `locateFile` to redirect
        // to the copy in dist/ placed by the `copy-grammars` build step.
        const wasmDir = vscode.Uri.joinPath(this.extensionUri, "dist", "grammars").fsPath;
        await mod.Parser.init({
          locateFile: (file: string) => `${wasmDir}/${file}`,
        });
        this.mod = mod;
        log.info("Tree-sitter WASM initialized");
      } catch (error) {
        log.error("Failed to initialize tree-sitter WASM", error);
        this.mod = undefined;
        // Clear the promise so subsequent calls retry instead of
        // permanently accepting the failed result.
        this.initPromise = undefined;
      }
    })();

    await this.initPromise;
  }

  /** Load a grammar WASM file and cache the Language. */
  private async loadLanguage(
    grammarName: string
  ): Promise<TreeSitter.Language | undefined> {
    const cached = this.languages.get(grammarName);
    if (cached) return cached;

    try {
      const wasmPath = this.resolveGrammarPath(grammarName);
      log.debug(`Loading grammar from: ${wasmPath}`);
      const language = await this.mod!.Language.load(wasmPath);
      this.languages.set(grammarName, language);
      log.info(`Loaded grammar: ${grammarName}`);
      return language;
    } catch (error) {
      log.error(`Failed to load grammar ${grammarName}`, String(error));
      return;
    }
  }

  /**
   * Resolve the filesystem path to a grammar WASM file.
   */
  private resolveGrammarPath(grammarName: string): string {
    return vscode.Uri.joinPath(
      this.extensionUri,
      "dist",
      "grammars",
      `${grammarName}.wasm`
    ).fsPath;
  }
}
