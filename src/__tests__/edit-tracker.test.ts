import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { EditTracker } from "../edit-tracker.ts";

describe("EditTracker", () => {
  let tracker: EditTracker;
  let changeHandler: (event: vscode.TextDocumentChangeEvent) => void;

  beforeEach(() => {
    // Capture the handler registered by EditTracker
    vi.mocked(vscode.workspace.onDidChangeTextDocument).mockImplementation(((
      handler: (event: vscode.TextDocumentChangeEvent) => void
    ) => {
      changeHandler = handler;
      return { dispose: vi.fn<() => void>() };
    }) as typeof vscode.workspace.onDidChangeTextDocument);
    tracker = new EditTracker();
  });

  afterEach(() => {
    tracker.dispose();
  });

  function fireChange(uri: string, startLine: number, endLine: number): void {
    changeHandler({
      document: {
        uri: { toString: () => uri, scheme: "file", fsPath: uri },
      } as unknown as vscode.TextDocument,
      contentChanges: [
        {
          range: new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, 0)
          ),
          rangeOffset: 0,
          rangeLength: 0,
          text: "",
        },
      ],
      reason: undefined,
    });
  }

  it("tracks edited files", () => {
    fireChange("file:///a.ts", 10, 10);
    const files = tracker.getRecentlyEditedFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.uri.toString()).toBe("file:///a.ts");
    expect(files[0]!.edits).toHaveLength(1);
    expect(files[0]!.edits[0]!.startLine).toBe(10);
  });

  it("excludes specified URI", () => {
    fireChange("file:///a.ts", 10, 10);
    fireChange("file:///b.ts", 5, 5);

    const excludeUri = {
      toString: () => "file:///a.ts",
    } as unknown as vscode.Uri;
    const files = tracker.getRecentlyEditedFiles(excludeUri);
    expect(files).toHaveLength(1);
    expect(files[0]!.uri.toString()).toBe("file:///b.ts");
  });

  it("sorts by most recent edit", () => {
    vi.useFakeTimers({ now: 1000 });
    fireChange("file:///old.ts", 1, 1);
    vi.advanceTimersByTime(100);
    fireChange("file:///new.ts", 1, 1);

    const files = tracker.getRecentlyEditedFiles();
    expect(files[0]!.uri.toString()).toBe("file:///new.ts");
    expect(files[1]!.uri.toString()).toBe("file:///old.ts");
    vi.useRealTimers();
  });

  it("prunes entries older than 2 minutes", () => {
    fireChange("file:///a.ts", 1, 1);

    // Advance time past the pruning window
    vi.useFakeTimers();
    vi.advanceTimersByTime(3 * 60 * 1000);

    const files = tracker.getRecentlyEditedFiles();
    expect(files).toHaveLength(0);

    vi.useRealTimers();
  });

  it("ignores non-file scheme URIs", () => {
    changeHandler({
      document: {
        uri: { toString: () => "output:///log", scheme: "output", fsPath: "" },
      } as unknown as vscode.TextDocument,
      contentChanges: [
        {
          range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
          rangeOffset: 0,
          rangeLength: 0,
          text: "",
        },
      ],
      reason: undefined,
    });

    expect(tracker.getRecentlyEditedFiles()).toHaveLength(0);
  });

  it("caps ranges per file at 5", () => {
    for (let i = 0; i < 10; i++) {
      fireChange("file:///a.ts", i, i);
    }
    const files = tracker.getRecentlyEditedFiles();
    expect(files[0]!.edits.length).toBeLessThanOrEqual(5);
  });

  it("records effective end line for multi-line insertions", () => {
    // Simulate pasting 5 lines at line 10. VS Code reports a zero-length
    // range at the cursor, but change.text contains the inserted newlines.
    changeHandler({
      document: {
        uri: { toString: () => "file:///a.ts", scheme: "file", fsPath: "file:///a.ts" },
      } as unknown as vscode.TextDocument,
      contentChanges: [
        {
          range: new vscode.Range(new vscode.Position(10, 0), new vscode.Position(10, 0)),
          rangeOffset: 0,
          rangeLength: 0,
          text: "line1\nline2\nline3\nline4\nline5",
        },
      ],
      reason: undefined,
    });

    const files = tracker.getRecentlyEditedFiles();
    expect(files).toHaveLength(1);
    const edit = files[0]!.edits[0]!;
    expect(edit.startLine).toBe(10);
    // 5 lines of text = 4 newlines → endLine should be 10 + 4 = 14
    expect(edit.endLine).toBe(14);
  });

  it("disposes cleanly", () => {
    tracker.dispose();
    // Should not throw
    expect(tracker.getRecentlyEditedFiles()).toHaveLength(0);
  });
});
