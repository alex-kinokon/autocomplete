/**
 * Inline completion provider.
 *
 * Wired into VSCode’s InlineCompletionItemProvider to show inline completion
 * suggestions. Handles debouncing, caching, cancellation, and skip heuristics.
 */
import { LRUCache } from "lru-cache";
import * as vscode from "vscode";

import {
  ModelLoadError,
  ModelNotFoundError,
  ServerBusyError,
  UnsupportedModeError,
  requestCompletion,
} from "./api.ts";
import { detectFimSupport, getApiKey, getConfig } from "./config.ts";
import { extractContext } from "./context.ts";
import type { DefinitionCache } from "./definition-cache.ts";
import type { EditTracker } from "./edit-tracker.ts";
import * as log from "./log.ts";
import type { SymbolCache } from "./symbol-cache.ts";
import type { ParserPool } from "./tree-sitter/parser-pool.ts";
import { validateCompletion } from "./tree-sitter/validation.ts";
import type { AutocompleteConfig } from "./types.ts";

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
  /** LRU cache keyed on document URI + recent prefix text. */
  private readonly cache = new LRUCache<string, string>({ max: 75 });
  /** Per-document abort controllers so requests in one editor don’t cancel another. */
  private readonly controllers = new Map<string, AbortController>();
  /** Whether the user has already been notified of a connection failure. */
  private notifiedError = false;
  /** Consecutive empty-result count per document. */
  private readonly emptyStreaks = new Map<string, number>();

  readonly definitionCache?: DefinitionCache;

  constructor(
    private readonly editTracker?: EditTracker,
    private readonly parserPool?: ParserPool,
    definitionCache?: DefinitionCache,
    private readonly symbolCache?: SymbolCache
  ) {
    this.definitionCache = definitionCache;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const apiKey = await getApiKey();
    const config = getConfig(document, apiKey);
    if (!config) return;

    // Abort any previous in-flight request for the same document
    const docKey = document.uri.toString();
    this.controllers.get(docKey)?.abort();
    const controller = new AbortController();
    this.controllers.set(docKey, controller);
    token.onCancellationRequested(() => controller.abort());

    try {
      // Debounce: wait for the user to stop typing
      await new Promise(resolve => setTimeout(resolve, config.debounceMs));
      if (token.isCancellationRequested || controller.signal.aborted) return;

      // Back off when the model has returned empty results repeatedly
      if ((this.emptyStreaks.get(docKey) ?? 0) >= 3) {
        this.emptyStreaks.set(docKey, (this.emptyStreaks.get(docKey) ?? 0) - 1);
        log.info("Skipping completion: repeated empty results");
        return;
      }

      // Check cache before making a network request
      const cacheKey = computeCacheKey(document, position);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        log.info(
          `Cache hit for ${vscode.workspace.asRelativePath(document.uri)}:${position.line + 1}`
        );
        return [
          new vscode.InlineCompletionItem(cached, new vscode.Range(position, position)),
        ];
      }

      const docContext = await extractContext(document, position, config.contextLines, {
        editTracker: this.editTracker,
        parserPool: this.parserPool,
        definitionCache: this.definitionCache,
        symbolCache: this.symbolCache,
      });

      // User is deleting text — don't suggest new code
      if (this.editTracker?.wasLastEditDeletion(document.uri)) {
        log.info("Skipping completion: last edit was deletion");
        return;
      }

      // Skip completions in cases where prompting would be useless or noisy
      const skipReason = shouldSkipCompletion(document, docContext.prefix, position);
      if (skipReason) {
        log.info(`Skipping completion: ${skipReason}`);
        return;
      }

      // Resolve FIM auto-detection on first request (result is cached)
      if (config.fimMode === "auto") {
        config.fim = await detectFimSupport(config.endpoint, config.model, config.apiKey);
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can change across await
      if (token.isCancellationRequested || controller.signal.aborted) return;

      log.info(
        `Requesting completion for ${docContext.relativePath}:${position.line + 1} (${config.fim ? "FIM" : "chat"}, ${config.model})`
      );
      const t0 = Date.now();
      let completion = await requestCompletion(config, docContext, controller.signal);
      if (!completion) {
        this.emptyStreaks.set(docKey, (this.emptyStreaks.get(docKey) ?? 0) + 1);
        log.info("Empty completion returned");
        return;
      }
      this.emptyStreaks.delete(docKey);

      // Syntax-aware validation: truncate at parse errors when parser available
      if (this.parserPool) {
        completion = await validateCompletion(
          this.parserPool,
          docContext.prefix,
          completion,
          docContext.suffix,
          docContext.languageId
        );
        if (!completion) {
          log.info("Completion rejected by syntax validation");
          return;
        }
      }

      log.info(
        `Completion received in ${Date.now() - t0}ms (${completion.length} chars)`
      );

      this.notifiedError = false;
      this.cache.set(cacheKey, completion);

      return [
        new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)),
      ];
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      log.error("Completion request failed", error);
      if (!this.notifiedError) {
        this.notifiedError = true;
        void vscode.window.showErrorMessage(errorToMessage(error, config));
      }
      return;
    } finally {
      // Clean up if this is still the active controller for this document
      if (this.controllers.get(docKey) === controller) {
        this.controllers.delete(docKey);
      }
    }
  }
}

/** Map a caught error to a user-facing localized notification message. */
function errorToMessage(error: unknown, config: AutocompleteConfig): string {
  if (error instanceof ModelNotFoundError) {
    return vscode.l10n.t('Autocomplete: model "{0}" not found.', config.model);
  }
  if (error instanceof UnsupportedModeError) {
    return vscode.l10n.t(
      'Autocomplete: model "{0}" does not support {1} mode.',
      config.model,
      error.mode
    );
  }
  if (error instanceof ModelLoadError) {
    return vscode.l10n.t(
      'Autocomplete: not enough memory to load "{0}". Try a smaller model.',
      config.model
    );
  }
  if (error instanceof ServerBusyError) {
    return vscode.l10n.t("Autocomplete: server is busy. Try again in a moment.");
  }
  return vscode.l10n.t(
    "Autocomplete: request failed. Is {0} reachable?",
    config.endpoint
  );
}

/** Matches lines containing only closing brackets/braces/parens. */
const CLOSING_ONLY = /^\s*[);>\]}]+\s*$/;

/**
 * Determine whether to skip completion for the current cursor position.
 * Returns a reason string if completion should be skipped, `undefined` otherwise.
 */
export function shouldSkipCompletion(
  document: vscode.TextDocument,
  prefix: string,
  position: vscode.Position
): string | undefined {
  if (document.lineCount === 1 && document.lineAt(0).text.trim() === "") {
    return "empty document";
  }

  if (!prefix.trim()) {
    return "empty prefix";
  }

  // User is just closing a block. Autocomplete would be noise
  const lineText = document.lineAt(position.line).text.slice(0, position.character);
  if (CLOSING_ONLY.test(lineText)) {
    return "closing bracket line";
  }

  // Cursor is inside a token — completing here would splice into a word
  const fullLineText = document.lineAt(position.line).text;
  const afterCursor = fullLineText[position.character];
  if (afterCursor && /\w/.test(afterCursor)) {
    return "middle of word";
  }

  // Substantial non-closer content after cursor — completion would be disruptive
  const textAfterCursor = fullLineText.slice(position.character);
  const stripped = textAfterCursor.replace(/^[\s"'),;\]}]*/, "");
  if (stripped.length > 0) {
    return "content after cursor";
  }

  return;
}

/** Cache key based on document URI + surrounding context (10 lines before and 3 after cursor). */
export function computeCacheKey(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const prefixStart = new vscode.Position(Math.max(0, position.line - 10), 0);
  const prefix = document.getText(new vscode.Range(prefixStart, position));
  const suffixEndLine = Math.min(document.lineCount - 1, position.line + 3);
  const suffixEnd = new vscode.Position(
    suffixEndLine,
    document.lineAt(suffixEndLine).text.length
  );
  const suffix = document.getText(new vscode.Range(position, suffixEnd));
  return JSON.stringify([document.uri.toString(), prefix, suffix]);
}
