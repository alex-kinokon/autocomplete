import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { ParserPool } from "../../tree-sitter/parser-pool.ts";

// Mock vscode.Uri.joinPath to return objects with fsPath
vi.mocked(vscode.Uri.joinPath).mockImplementation(
  (_base: vscode.Uri, ...segments: readonly string[]) =>
    ({
      fsPath: `/mock/${segments.join("/")}`,
      toString: () => `file:///mock/${segments.join("/")}`,
    }) as unknown as vscode.Uri
);

describe("ParserPool", () => {
  it("returns undefined for unsupported languages", async () => {
    const pool = new ParserPool({} as vscode.Uri);
    // "html" has no grammar in the language map
    const tree = await pool.parse("const x = 1;", "html");
    expect(tree).toBeUndefined();
    pool.dispose();
  });

  it("dispose() does not throw on fresh pool", () => {
    const pool = new ParserPool({} as vscode.Uri);
    expect(() => pool.dispose()).not.toThrow();
  });

  it("dispose() can be called multiple times", () => {
    const pool = new ParserPool({} as vscode.Uri);
    pool.dispose();
    expect(() => pool.dispose()).not.toThrow();
  });

  it("retries initialization after transient failure", async () => {
    // Mock dynamic import to control initialization behavior
    const mockInit = vi.fn<() => Promise<void>>();
    vi.doMock("web-tree-sitter", () => ({
      default: { Parser: { init: mockInit } },
      Parser: { init: mockInit },
    }));

    // Re-import to pick up the mock
    const { ParserPool: FreshPool } = await import("../../tree-sitter/parser-pool.ts");
    const pool = new FreshPool({} as vscode.Uri);

    // First init: fails
    mockInit.mockRejectedValueOnce(new Error("transient WASM failure"));
    const r1 = await pool.parse("const x = 1;", "typescript");
    expect(r1).toBeUndefined();
    expect(mockInit).toHaveBeenCalledOnce();

    // Second init: should retry (not serve cached failure)
    mockInit.mockRejectedValueOnce(new Error("still failing"));
    const r2 = await pool.parse("const x = 1;", "typescript");
    expect(r2).toBeUndefined();
    expect(mockInit).toHaveBeenCalledTimes(2);

    pool.dispose();
    vi.doUnmock("web-tree-sitter");
  });
});
