import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { EditTracker } from "../edit-tracker.ts";
import {
  AutocompleteProvider,
  computeCacheKey,
  shouldSkipCompletion,
} from "../provider.ts";

function makeDocument(lines: string[], uri = "file:///test.ts"): vscode.TextDocument {
  const text = lines.join("\n");
  return {
    uri: { toString: () => uri },
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    getText: (range?: vscode.Range) => {
      if (!range) return text;
      const startOffset =
        lines.slice(0, range.start.line).join("\n").length +
        (range.start.line > 0 ? 1 : 0) +
        range.start.character;
      const endOffset =
        lines.slice(0, range.end.line).join("\n").length +
        (range.end.line > 0 ? 1 : 0) +
        range.end.character;
      return text.slice(startOffset, endOffset);
    },
  } as unknown as vscode.TextDocument;
}

describe("computeCacheKey", () => {
  it("produces different keys for same prefix but different suffix", () => {
    const docA = makeDocument([
      "function foo() {",
      "  // cursor here",
      "  return 1;",
      "}",
    ]);
    const docB = makeDocument([
      "function foo() {",
      "  // cursor here",
      "  return 2;",
      "}",
    ]);

    const pos = new vscode.Position(1, 16);
    const keyA = computeCacheKey(docA, pos);
    const keyB = computeCacheKey(docB, pos);

    expect(keyA).not.toBe(keyB);
  });

  it("produces the same key for identical context", () => {
    const doc = makeDocument(["function foo() {", "  return 1;", "}"]);

    const pos = new vscode.Position(1, 11);
    expect(computeCacheKey(doc, pos)).toBe(computeCacheKey(doc, pos));
  });

  it("includes document URI in key", () => {
    const lines = ["const x = 1;"];
    const docA = makeDocument(lines, "file:///a.ts");
    const docB = makeDocument(lines, "file:///b.ts");

    const pos = new vscode.Position(0, 12);
    expect(computeCacheKey(docA, pos)).not.toBe(computeCacheKey(docB, pos));
  });

  it("handles cursor at start of document", () => {
    const doc = makeDocument(["first line", "second line"]);
    const pos = new vscode.Position(0, 0);

    // Should not throw
    const key = computeCacheKey(doc, pos);
    expect(key).toContain("file:///test.ts");
  });

  it("handles cursor near end of document", () => {
    const doc = makeDocument(["line 1", "line 2"]);
    const pos = new vscode.Position(1, 6);

    // Should not throw even when suffix window extends beyond document
    const key = computeCacheKey(doc, pos);
    expect(key).toContain("file:///test.ts");
  });

  it("includes post-cursor text in suffix on last line", () => {
    const doc = makeDocument(["hello world"]);
    const pos = new vscode.Position(0, 5);

    const key = computeCacheKey(doc, pos);
    // Suffix should contain text after cursor (" world"), not be empty
    expect(key).toContain(" world");
  });

  it("does not collide when prefix/suffix contain the old delimiter", () => {
    // Regression: with "::" delimiters, prefix="a::b" suffix="c" and
    // prefix="a" suffix="b::c" would produce the same key.
    const docA = makeDocument(["a::b", "c"], "file:///test.ts");
    const docB = makeDocument(["a", "b::c"], "file:///test.ts");

    const keyA = computeCacheKey(docA, new vscode.Position(0, 4));
    const keyB = computeCacheKey(docB, new vscode.Position(0, 1));

    expect(keyA).not.toBe(keyB);
  });
});

describe("shouldSkipCompletion", () => {
  it("skips single-line empty documents", () => {
    const doc = makeDocument([""]);
    expect(shouldSkipCompletion(doc, "", new vscode.Position(0, 0))).toBe(
      "empty document"
    );
  });

  it("skips whitespace-only single-line documents", () => {
    const doc = makeDocument(["   "]);
    expect(shouldSkipCompletion(doc, "   ", new vscode.Position(0, 3))).toBe(
      "empty document"
    );
  });

  it("does not scan full document text for multi-line files", () => {
    // A multi-line document is never considered empty, even if content is
    // mostly whitespace. The check should be O(1), not O(file_size).
    const doc = makeDocument(["", "  some code  ", ""]);
    expect(shouldSkipCompletion(doc, "", new vscode.Position(0, 0))).toBe("empty prefix");
    // Importantly, it did NOT return "empty document"
  });

  it("allows completion in non-empty documents", () => {
    const doc = makeDocument(["const x = 1;", "const y ="]);
    expect(
      shouldSkipCompletion(doc, "const y =", new vscode.Position(1, 9))
    ).toBeUndefined();
  });

  it("skips when cursor is in the middle of a word", () => {
    const doc = makeDocument(["foobar"]);
    // cursor between 'foo' and 'bar'
    expect(shouldSkipCompletion(doc, "foo", new vscode.Position(0, 3))).toBe(
      "middle of word"
    );
  });

  it("allows completion at the end of a word", () => {
    const doc = makeDocument(["foobar "]);
    // cursor after 'foobar' with space following
    expect(
      shouldSkipCompletion(doc, "foobar", new vscode.Position(0, 6))
    ).toBeUndefined();
  });

  it("allows completion before closing brackets", () => {
    const doc = makeDocument(["const x = foo()"]);
    // cursor at |)
    expect(
      shouldSkipCompletion(doc, "const x = foo(", new vscode.Position(0, 14))
    ).toBeUndefined();
  });

  it("allows completion before closing bracket + semicolon", () => {
    const doc = makeDocument(["foo();"]);
    // cursor at |);
    expect(shouldSkipCompletion(doc, "foo(", new vscode.Position(0, 4))).toBeUndefined();
  });

  it("skips when there is content after cursor", () => {
    // cursor before "- bar" (non-word char, but substantial content remains)
    const doc = makeDocument(["x - bar"]);
    expect(shouldSkipCompletion(doc, "x ", new vscode.Position(0, 2))).toBe(
      "content after cursor"
    );
  });

  it("skips when operator content follows cursor", () => {
    const doc = makeDocument(["a + bar"]);
    // cursor at 'a |+ bar'
    expect(shouldSkipCompletion(doc, "a ", new vscode.Position(0, 2))).toBe(
      "content after cursor"
    );
  });
});

// --- Controller lifecycle tests ---

vi.mock("../config.ts", () => ({
  getApiKey: vi.fn<() => Promise<string | undefined>>(() => Promise.resolve(undefined)),
  getConfig: vi.fn<(doc: unknown, apiKey?: string) => Record<string, unknown>>(() => ({
    endpoint: "http://localhost:11434/v1",
    model: "test",
    maxTokens: 128,
    temperature: 0,
    stop: ["\n\n"],
    fimMode: "off",
    debounceMs: 0,
    contextLines: 100,
    systemPrompt: "",
  })),
  detectFimSupport: vi.fn<() => Promise<undefined>>(() => Promise.resolve(undefined)),
}));

vi.mock("../context.ts", () => ({
  extractContext: vi.fn<() => Promise<Record<string, unknown>>>(() =>
    Promise.resolve({
      prefix: "const x = ",
      suffix: ";\n",
      languageId: "typescript",
      relativePath: "test.ts",
      relatedSnippets: [],
    })
  ),
}));

vi.mock("../api.ts", () => ({
  requestCompletion: vi.fn<() => Promise<string>>(() => Promise.resolve("42")),
  ModelNotFoundError: class extends Error {},
  ModelLoadError: class extends Error {},
  ServerBusyError: class extends Error {},
  UnsupportedModeError: class extends Error {},
}));

function makeProviderDocument(uri: string): vscode.TextDocument {
  return makeDocument(["const x = ", "const y = 2;"], uri);
}

function makeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: vi.fn<() => vscode.Disposable>(() => ({
      dispose: vi.fn<() => void>(),
    })),
  } as unknown as vscode.CancellationToken;
}

const dummyContext = {} as vscode.InlineCompletionContext;

describe("AutocompleteProvider controller lifecycle", () => {
  let provider: AutocompleteProvider;

  function controllers(): Map<string, AbortController> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (provider as any).controllers as Map<string, AbortController>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AutocompleteProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses explicit insertion range for both cached and fresh completions", async () => {
    const doc = makeProviderDocument("file:///range-test.ts");
    const pos = new vscode.Position(0, 10);

    // First call: fresh completion
    const fresh = await provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );
    expect(fresh).toHaveLength(1);
    const freshItem = fresh![0]!;
    expect(freshItem.range).toBeDefined();

    // Second call: cache hit (same doc, same position, same context)
    const cached = await provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );
    expect(cached).toHaveLength(1);
    const cachedItem = cached![0]!;
    // Cache hit should also have an explicit range
    expect(cachedItem.range).toBeDefined();
  });

  it("cleans up controller after successful completion", async () => {
    const doc = makeProviderDocument("file:///a.ts");
    const pos = new vscode.Position(0, 10);

    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());

    expect(controllers().size).toBe(0);
  });

  it("cleans up controller after request error", async () => {
    const { requestCompletion } = await import("../api.ts");
    vi.mocked(requestCompletion).mockRejectedValueOnce(new Error("network down"));

    const doc = makeProviderDocument("file:///a.ts");
    const pos = new vscode.Position(0, 10);

    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());

    expect(controllers().size).toBe(0);
  });

  it("aborts previous controller when same document requests again", async () => {
    const { requestCompletion } = await import("../api.ts");
    const signals: AbortSignal[] = [];

    vi.mocked(requestCompletion).mockImplementation((_cfg, _ctx, signal) => {
      signals.push(signal);
      return Promise.resolve("ok");
    });

    const doc = makeProviderDocument("file:///a.ts");
    const pos = new vscode.Position(0, 10);

    // Both calls run concurrently; the second aborts the first’s controller.
    // The first request bails out before reaching requestCompletion because
    // controller.signal.aborted is checked after debounce.
    const first = provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );
    const second = provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );

    const firstResult = await first;
    await second;

    // First request bails out before requestCompletion
    expect(firstResult).toBeUndefined();
    // Only second (non-aborted) request reaches requestCompletion
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(controllers().size).toBe(0);
  });

  it("does not abort controller for a different document", async () => {
    const { requestCompletion } = await import("../api.ts");
    const abortedDocs: string[] = [];
    vi.mocked(requestCompletion).mockImplementation((_cfg, _ctx, signal) => {
      signal.addEventListener("abort", () => {
        abortedDocs.push("aborted");
      });
      return Promise.resolve("ok");
    });

    const docA = makeProviderDocument("file:///a.ts");
    const docB = makeProviderDocument("file:///b.ts");
    const pos = new vscode.Position(0, 10);

    await Promise.all([
      provider.provideInlineCompletionItems(docA, pos, dummyContext, makeToken()),
      provider.provideInlineCompletionItems(docB, pos, dummyContext, makeToken()),
    ]);

    expect(abortedDocs).toHaveLength(0);
    expect(controllers().size).toBe(0);
  });

  it("bails out before extractContext when controller is aborted", async () => {
    const { extractContext } = await import("../context.ts");
    const extractSpy = vi.mocked(extractContext);
    extractSpy.mockClear();

    const doc = makeProviderDocument("file:///abort-test.ts");
    const pos = new vscode.Position(0, 10);

    // Two concurrent requests: the second aborts the first’s controller.
    // With debounceMs=0, the first request should see controller.signal.aborted
    // after its setTimeout fires and bail out before calling extractContext.
    const first = provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );
    const second = provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );

    await first;
    await second;

    // Only the second (non-aborted) request should have called extractContext
    expect(extractSpy).toHaveBeenCalledOnce();
  });

  it("does not remove a newer controller when an older request finishes", async () => {
    const doc = makeProviderDocument("file:///a.ts");
    const pos = new vscode.Position(0, 10);

    // Start first (slow) request
    const first = provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );
    // Start second (fast) request. This replaces the controller,
    // aborting the first. The first bails out early due to
    // controller.signal.aborted check after debounce.
    const second = provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );

    const firstResult = await first;
    await second;

    // First request bails out, second completes normally
    expect(firstResult).toBeUndefined();
    expect(controllers().size).toBe(0);
  });
});

// --- Deletion skip heuristic ---

describe("deletion skip heuristic", () => {
  it("skips completion when last edit was a deletion", async () => {
    const editTracker = {
      wasLastEditDeletion: vi.fn<() => boolean>(() => true),
      getRecentlyEditedFiles: vi.fn<() => []>(() => []),
    } satisfies Partial<EditTracker>;

    const provider = new AutocompleteProvider(editTracker as unknown as EditTracker);
    const doc = makeProviderDocument("file:///del.ts");
    const pos = new vscode.Position(0, 10);

    const result = await provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );

    expect(result).toBeUndefined();
    expect(editTracker.wasLastEditDeletion).toHaveBeenCalledWith(doc.uri);
  });

  it("does not skip when last edit was not a deletion", async () => {
    const editTracker = {
      wasLastEditDeletion: vi.fn<() => boolean>(() => false),
      getRecentlyEditedFiles: vi.fn<() => []>(() => []),
    } satisfies Partial<EditTracker>;

    const provider = new AutocompleteProvider(editTracker as unknown as EditTracker);
    const doc = makeProviderDocument("file:///nodel.ts");
    const pos = new vscode.Position(0, 10);

    const result = await provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );

    // Should return a completion (not skipped by deletion check)
    expect(result).toHaveLength(1);
  });
});

// --- Empty streak heuristic ---

describe("empty streak heuristic", () => {
  it("skips after 3 consecutive empty results", async () => {
    const { requestCompletion } = await import("../api.ts");
    vi.mocked(requestCompletion).mockResolvedValue("");

    const provider = new AutocompleteProvider();
    const doc = makeProviderDocument("file:///streak.ts");
    const pos = new vscode.Position(0, 10);

    // First 3 requests return empty — build up streak
    for (let i = 0; i < 3; i++) {
      await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());
    }

    // 4th request should be skipped (streak >= 3)
    vi.mocked(requestCompletion).mockClear();
    const result = await provider.provideInlineCompletionItems(
      doc,
      pos,
      dummyContext,
      makeToken()
    );

    expect(result).toBeUndefined();
    // requestCompletion should NOT have been called (skipped early)
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it("retries periodically by decrementing streak", async () => {
    const { requestCompletion } = await import("../api.ts");
    vi.mocked(requestCompletion).mockResolvedValue("");

    const provider = new AutocompleteProvider();
    const doc = makeProviderDocument("file:///streak2.ts");
    const pos = new vscode.Position(0, 10);

    // Build streak to 3
    for (let i = 0; i < 3; i++) {
      await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());
    }

    // 4th: skipped (streak 3 → 2)
    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());

    // 5th: streak is 2 < 3, so it goes through
    vi.mocked(requestCompletion).mockClear();
    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());
    expect(requestCompletion).toHaveBeenCalledOnce();
  });

  it("resets streak on non-empty result", async () => {
    const { requestCompletion } = await import("../api.ts");
    vi.mocked(requestCompletion).mockResolvedValue("");

    const provider = new AutocompleteProvider();
    const doc = makeProviderDocument("file:///streak3.ts");
    const pos = new vscode.Position(0, 10);

    // Build streak to 2
    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());
    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());

    // Return non-empty — should reset streak
    vi.mocked(requestCompletion).mockResolvedValue("42");
    await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());

    // Clear the cache so subsequent requests actually reach requestCompletion
    provider.clearCache();

    // Next 3 empties should not cause a skip yet (streak reset to 0)
    vi.mocked(requestCompletion).mockResolvedValue("");
    vi.mocked(requestCompletion).mockClear();
    for (let i = 0; i < 3; i++) {
      await provider.provideInlineCompletionItems(doc, pos, dummyContext, makeToken());
    }
    // All 3 should have gone through
    expect(requestCompletion).toHaveBeenCalledTimes(3);
  });
});
