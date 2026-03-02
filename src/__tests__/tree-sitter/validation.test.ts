import { describe, expect, it, vi } from "vitest";

import type { ParserPool } from "../../tree-sitter/parser-pool.ts";
import { validateCompletion } from "../../tree-sitter/validation.ts";

import { MockNode, MockTree } from "./mock-tree.ts";

/** Create a mock ParserPool whose parse() returns the given tree. */
function mockPool(treeFn: (text: string) => MockTree | undefined): ParserPool {
  return {
    parse: vi.fn<(text: string, lang: string) => Promise<MockTree | undefined>>(
      // eslint-disable-next-line @typescript-eslint/require-await
      async text => treeFn(text)
    ),
  } as unknown as ParserPool;
}

/** Build a clean tree (no errors) for any input. */
function cleanTree(): MockTree {
  return new MockTree(
    new MockNode({
      type: "program",
      startRow: 0,
      endRow: 100,
      startIndex: 0,
      endIndex: 10000,
      children: [],
    })
  );
}

/** Build a tree with an ERROR node at the given byte range. */
function errorTree(errorStart: number, errorEnd: number): MockTree {
  const errorNode = new MockNode({
    type: "ERROR",
    startRow: 0,
    endRow: 0,
    startIndex: errorStart,
    endIndex: errorEnd,
    isError: true,
  });
  return new MockTree(
    new MockNode({
      type: "program",
      startRow: 0,
      endRow: 100,
      startIndex: 0,
      endIndex: 10000,
      children: [errorNode],
    })
  );
}

/** Build a tree with a MISSING node at the given byte offset. */
function missingTree(missingStart: number): MockTree {
  const missingNode = new MockNode({
    type: ";",
    startRow: 0,
    endRow: 0,
    startIndex: missingStart,
    endIndex: missingStart,
    isMissing: true,
  });
  return new MockTree(
    new MockNode({
      type: "program",
      startRow: 0,
      endRow: 100,
      startIndex: 0,
      endIndex: 10000,
      children: [missingNode],
    })
  );
}

describe("validateCompletion", () => {
  it("returns completion unchanged when no errors", async () => {
    const pool = mockPool(() => cleanTree());
    const result = await validateCompletion(
      pool,
      "const x = ",
      "42;",
      "\n",
      "typescript"
    );
    expect(result).toBe("42;");
  });

  it("returns completion unchanged when parser unavailable", async () => {
    const pool = mockPool(() => undefined);
    const result = await validateCompletion(
      pool,
      "const x = ",
      "42;",
      "\n",
      "typescript"
    );
    expect(result).toBe("42;");
  });

  it("rejects single-line completion with errors", async () => {
    const prefix = "const x = ";
    const completion = "42 +++;";
    // Error in the completion region
    const pool = mockPool(() =>
      errorTree(prefix.length, prefix.length + completion.length)
    );
    const result = await validateCompletion(pool, prefix, completion, "\n", "typescript");
    // Single-line with errors → rejected
    expect(result).toBe("");
  });

  it("binary searches multi-line completions for valid prefix", async () => {
    const prefix = "function foo() {\n";
    const completion = "  const x = 1;\n  const y = 2;\n  invalid!!!";
    const suffix = "\n}";

    let callCount = 0;
    const pool = mockPool((text: string) => {
      callCount++;
      // Simulate: first 2 lines are valid, 3rd line causes error
      if (text.includes("invalid!!!")) {
        const errorStart = text.indexOf("invalid!!!");
        return errorTree(errorStart, errorStart + 10);
      }
      return cleanTree();
    });

    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );

    // Should have truncated to the valid portion
    expect(result).not.toContain("invalid!!!");
    expect(result).toContain("const x = 1;");
    // Binary search should have called parse multiple times
    expect(callCount).toBeGreaterThan(1);
  });

  it("detects MISSING nodes as errors", async () => {
    const prefix = "const x = ";
    const completion = "foo(\nbar";
    const suffix = "\n";

    // MISSING node in the completion region (e.g. missing closing paren)
    const pool = mockPool(() => missingTree(prefix.length + 3));

    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );

    // Multi-line, binary search attempted. Since even line 0 has the error,
    // no valid prefix found → rejected
    expect(result).toBe("");
  });

  it("deletes the initial tree after use", async () => {
    const tree = cleanTree();
    const pool = mockPool(() => tree);
    await validateCompletion(pool, "x", "y", "z", "typescript");
    expect(tree.isDeleted).toBe(true);
  });

  it("ignores errors outside the completion region", async () => {
    const prefix = "const bad ===;\n"; // 15 bytes, error in prefix
    const completion = "const good = 1;";
    const suffix = "\n";

    // Error is in the prefix region (bytes 0-14), not completion
    const pool = mockPool(() => errorTree(0, 14));
    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );
    expect(result).toBe(completion);
  });

  it("uses UTF-8 byte offsets for non-ASCII prefixes", async () => {
    // "café" is 5 UTF-16 code units but 6 UTF-8 bytes (é = 2 bytes)
    const prefix = "const café = ";
    const completion = "42;";
    const suffix = "\n";

    const prefixBytes = Buffer.byteLength(prefix, "utf8"); // 15
    const completionBytes = Buffer.byteLength(completion, "utf8"); // 3

    // Error at byte range that only overlaps completion if byte offsets are
    // used correctly (UTF-16 .length would compute 14, missing the error)
    const pool = mockPool(() => errorTree(prefixBytes, prefixBytes + completionBytes));
    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );
    // Single-line with error → rejected. The important thing is the error WAS
    // detected (if we used .length it would compute offset 14 instead of 15,
    // misaligning the range check and missing the error entirely)
    expect(result).toBe("");
  });

  it("detects errors correctly with CJK characters in prefix", async () => {
    // "変数" = 2 chars in UTF-16 but 6 bytes in UTF-8 (3 bytes each)
    const prefix = "const 変数 = ";
    const completion = "foo(\nbar";
    const suffix = "\n)";

    const prefixBytes = Buffer.byteLength(prefix, "utf8"); // 15
    // Error just past the prefix boundary (inside completion region)
    const pool = mockPool(() => errorTree(prefixBytes + 1, prefixBytes + 5));
    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );
    // Multi-line with error → binary search attempted, even first line
    // has the error → rejected
    expect(result).toBe("");
  });

  it("correctly places completion boundary with emoji prefix", async () => {
    // "😀" = 2 UTF-16 code units (surrogate pair) but 4 UTF-8 bytes
    const prefix = "const 😀 = ";
    const completion = "1;";
    const suffix = "\n";

    const prefixBytes = Buffer.byteLength(prefix, "utf8"); // 14
    expect(prefixBytes).not.toBe(prefix.length); // Verify they differ

    // Error outside completion (in prefix) using byte offsets
    const pool = mockPool(() => errorTree(0, prefixBytes - 1));
    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );
    expect(result).toBe(completion); // No error in completion region
  });

  it("returns best valid prefix when parser fails mid-search", async () => {
    const prefix = "function foo() {\n";
    const completion = "  const x = 1;\n  const y = 2;\n  invalid!!!";
    const suffix = "\n}";

    let callCount = 0;
    const pool = mockPool((text: string) => {
      callCount++;
      // First call: initial validation (full completion has error)
      if (callCount === 1) {
        const errorStart = text.indexOf("invalid!!!");
        return errorTree(errorStart, errorStart + 10);
      }
      // Second call: binary search finds first candidate valid
      if (callCount === 2) {
        return cleanTree();
      }
      // Subsequent calls: parser fails (returns undefined)
      return;
    });

    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );

    // Should return the best valid prefix found before parser failure,
    // NOT the original invalid completion
    expect(result).not.toContain("invalid!!!");
    expect(result).toContain("const x = 1;");
  });

  it("returns empty string when parser fails before any valid prefix found", async () => {
    const prefix = "function foo() {\n";
    const completion = "  bad line 1\n  bad line 2\n  bad line 3";
    const suffix = "\n}";

    let callCount = 0;
    const pool = mockPool((_text: string) => {
      callCount++;
      // First call: initial validation. Full completion has error
      if (callCount === 1) {
        return errorTree(prefix.length, prefix.length + completion.length);
      }
      // All subsequent calls: parser fails
      return;
    });

    const result = await validateCompletion(
      pool,
      prefix,
      completion,
      suffix,
      "typescript"
    );

    // No valid prefix found before parser failure → reject entirely
    expect(result).toBe("");
  });
});
