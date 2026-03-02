/**
 * Recently-edited file tracker.
 *
 * Files edited in the last few minutes are highly relevant context for
 * completion, even if they are no longer visible in the editor.
 */
import * as vscode from "vscode";

/** Edits older than this are pruned on access. */
const MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes
/** Maximum number of distinct files to track. Oldest file is evicted on overflow. */
const MAX_FILES = 20;
/** Maximum edit ranges retained per file. Oldest ranges are dropped on overflow. */
const MAX_RANGES_PER_FILE = 5;

/** A recorded edit range with its timestamp. */
export interface EditRecord {
  readonly startLine: number;
  readonly endLine: number;
  readonly timestamp: number;
}

/** Edit history for a single file. */
export interface FileEditHistory {
  readonly uri: vscode.Uri;
  readonly edits: readonly EditRecord[];
}

/**
 * Tracks recently-edited files and ranges.
 *
 * Subscribes to `workspace.onDidChangeTextDocument` and maintains a
 * bounded, time-pruned record of recent edits.
 */
export class EditTracker implements vscode.Disposable {
  private readonly history = new Map<
    string,
    { readonly uri: vscode.Uri; edits: EditRecord[] }
  >();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== "file") return;
      this.recordEdit(event);
    });
  }

  dispose(): void {
    this.disposable.dispose();
  }

  /** Record edits from a text document change event. */
  private recordEdit(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    const now = Date.now();

    let entry = this.history.get(key);
    if (!entry) {
      entry = { uri: event.document.uri, edits: [] };
      this.history.set(key, entry);
    }

    for (const change of event.contentChanges) {
      // For insertions, change.range is zero-length at the cursor but
      // change.text may span multiple lines. Compute the effective end
      // line so extractEditedRanges covers the full inserted range.
      const insertedLines = change.text.split("\n").length - 1;
      const endLine = Math.max(
        change.range.end.line,
        change.range.start.line + insertedLines
      );
      entry.edits.push({
        startLine: change.range.start.line,
        endLine,
        timestamp: now,
      });
    }

    // Cap ranges per file
    if (entry.edits.length > MAX_RANGES_PER_FILE) {
      entry.edits = entry.edits.slice(-MAX_RANGES_PER_FILE);
    }

    // Cap total files (evict oldest)
    if (this.history.size > MAX_FILES) {
      const oldest = this.findOldestFile();
      if (oldest) this.history.delete(oldest);
    }
  }

  /**
   * Get recently-edited files sorted by most recent edit.
   *
   * Prunes entries older than {@link MAX_AGE_MS} on access.
   *
   * @param excludeUri File to exclude (typically the current document)
   */
  getRecentlyEditedFiles(excludeUri?: vscode.Uri): FileEditHistory[] {
    const now = Date.now();
    const cutoff = now - MAX_AGE_MS;
    const excludeKey = excludeUri?.toString();

    // Prune old entries
    for (const [key, entry] of this.history) {
      entry.edits = entry.edits.filter(e => e.timestamp > cutoff);
      if (entry.edits.length === 0) {
        this.history.delete(key);
      }
    }

    const result: FileEditHistory[] = [];
    for (const [key, entry] of this.history) {
      if (key === excludeKey) continue;
      result.push({ uri: entry.uri, edits: [...entry.edits] });
    }

    // Sort by most recent edit timestamp (descending)
    result.sort((a, b) => {
      const aMax = Math.max(...a.edits.map(e => e.timestamp));
      const bMax = Math.max(...b.edits.map(e => e.timestamp));
      return bMax - aMax;
    });

    return result;
  }

  private findOldestFile(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.history) {
      const maxTime = Math.max(...entry.edits.map(e => e.timestamp));
      if (maxTime < oldestTime) {
        oldestTime = maxTime;
        oldestKey = key;
      }
    }

    return oldestKey;
  }
}
