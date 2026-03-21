/**
 * Cached definition provider.
 *
 * Wraps `vscode.executeDefinitionProvider` with TTL-based caching, concurrency
 * limiting (max 2 outstanding LSP calls), and request coalescing. Each LSP
 * definition lookup costs 200-500ms, so only cache hits should be used in the
 * hot completion path.
 */
import { LRUCache } from "lru-cache";
import * as vscode from "vscode";

import * as log from "./log.ts";

/**
 * Maximum concurrent LSP definition requests.
 *
 * Set higher than MAX_DEFINITIONS (3) to avoid starvation when callers
 * use timeouts. Timed-out lookups still occupy slots until the underlying
 * LSP call completes.
 */
const MAX_CONCURRENT = 5;

interface CacheEntry {
  readonly locations: vscode.Location[];
  /** Document version at the time of lookup. Used for invalidation. */
  readonly documentVersion: number;
}

export class DefinitionCache implements vscode.Disposable {
  private readonly cache = new LRUCache<string, CacheEntry>({
    max: 200,
    ttl: 60_000,
  });
  /** In-flight LSP requests keyed by cache key, for coalescing. */
  private readonly pending = new Map<
    string,
    {
      readonly promise: Promise<vscode.Location[] | undefined>;
      readonly version: number;
    }
  >();
  private inflight = 0;
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme === "file") {
        this.invalidate(event.document.uri);
      }
    });
  }

  dispose(): void {
    this.disposable.dispose();
    this.cache.clear();
    this.pending.clear();
  }

  /**
   * Look up definitions for the symbol at the given position.
   *
   * Returns cached result if available and still valid. Otherwise issues an
   * LSP request (subject to the concurrency limit). Returns `undefined` if
   * the concurrency limit is reached or the lookup fails.
   *
   * @param uri Document URI containing the symbol
   * @param position Position of the symbol to look up
   * @param documentVersion Current document version for cache invalidation
   */
  async lookup(
    uri: vscode.Uri,
    position: vscode.Position,
    documentVersion: number
  ): Promise<vscode.Location[] | undefined> {
    const key = cacheKey(uri, position);

    // Check cache
    const cached = this.getValid(key, documentVersion);
    if (cached) return cached;

    // Coalesce with in-flight request for same key and version
    const existing = this.pending.get(key);
    if (existing && existing.version === documentVersion) {
      return existing.promise;
    }

    // Enforce concurrency limit
    if (this.inflight >= MAX_CONCURRENT) {
      log.debug("Definition cache: concurrency limit reached, skipping lookup");
      return;
    }

    const promise = this.executeAndCache(key, uri, position, documentVersion);
    this.pending.set(key, { promise, version: documentVersion });
    return promise;
  }

  /**
   * Check cache only. No LSP call. For use in the hot completion path
   * where we can’t afford to wait for an LSP round-trip.
   *
   * @param uri Document URI containing the symbol
   * @param position Position of the symbol
   * @param documentVersion Current document version for validation
   */
  getCached(
    uri: vscode.Uri,
    position: vscode.Position,
    documentVersion: number
  ): vscode.Location[] | undefined {
    return this.getValid(cacheKey(uri, position), documentVersion);
  }

  /** Remove all cache entries for a given document URI. */
  invalidate(uri: vscode.Uri): void {
    const prefix = uri.toString() + "::";
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Return locations from a valid (version-matched) cache entry, or undefined. */
  private getValid(key: string, documentVersion: number): vscode.Location[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) return;

    if (entry.documentVersion !== documentVersion) {
      this.cache.delete(key);
      return;
    }

    return entry.locations;
  }

  /** Execute the LSP definition request and cache the result. */
  private async executeAndCache(
    key: string,
    uri: vscode.Uri,
    position: vscode.Position,
    documentVersion: number
  ): Promise<vscode.Location[] | undefined> {
    this.inflight++;

    try {
      // Result may be Location, Location[], LocationLink[], or undefined.
      // @see {vscode.DefinitionProvider.provideDefinition}
      const result = await vscode.commands.executeCommand<
        vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined
      >("vscode.executeDefinitionProvider", uri, position);

      const locations = normalizeLocations(result);
      this.cache.set(key, { locations, documentVersion });
      log.debug(`Definition cache: stored ${locations.length} locations for ${key}`);
      return locations;
    } catch (error) {
      log.error("Definition lookup failed", String(error));
      return;
    } finally {
      // Release the concurrency slot only when the underlying LSP call
      // settles and not on caller timeout. This prevents real outstanding
      // requests from exceeding MAX_CONCURRENT.
      this.inflight--;
      // Only clear if this is still the active pending entry (a newer
      // version may have replaced it while we were in flight).
      const entry = this.pending.get(key);
      if (entry?.version === documentVersion) {
        this.pending.delete(key);
      }
    }
  }
}

function cacheKey(uri: vscode.Uri, position: vscode.Position): string {
  return `${uri.toString()}::${position.line}::${position.character}`;
}

/** Type guard: `LocationLink` has `targetUri`, `Location` has `uri`. */
function isLocationLink(
  loc: vscode.Location | vscode.LocationLink
): loc is vscode.LocationLink {
  return "targetUri" in loc;
}

/**
 * Normalize the polymorphic result of `vscode.executeDefinitionProvider` to `Location[]`.
 *
 * The command can return a single `Location`, `Location[]`, `LocationLink[]`, or
 * `undefined`/`null`. `LocationLink` items have `targetUri`/`targetSelectionRange`
 * instead of `uri`/`range`.
 * @see {vscode.DefinitionProvider.provideDefinition}
 */
function normalizeLocations(
  result: vscode.Location | vscode.Location[] | vscode.LocationLink[] | null | undefined
): vscode.Location[] {
  if (!result) return [];

  const items = Array.isArray(result) ? result : [result];
  return items.map(loc =>
    isLocationLink(loc)
      ? ({
          uri: loc.targetUri,
          range: loc.targetSelectionRange ?? loc.targetRange,
        } as vscode.Location)
      : loc
  );
}
