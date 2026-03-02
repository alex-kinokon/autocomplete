import { describe, expect, it } from "vitest";
import * as vscode from "vscode";

import {
  commentPrefix,
  extractEditedRanges,
  extractImports,
  formatSymbolPathContext,
  isImportMatch,
} from "../context.ts";
import type { FileEditHistory } from "../edit-tracker.ts";

describe("commentPrefix", () => {
  it("returns // for C-like languages", () => {
    for (const lang of ["typescript", "javascript", "java", "c", "go", "rust"]) {
      expect(commentPrefix(lang)).toBe("//");
    }
  });

  it("returns # for scripting languages", () => {
    for (const lang of [
      "python",
      "ruby",
      "shellscript",
      "yaml",
      "perl",
      "coffeescript",
      "r",
      "julia",
      "elixir",
      "powershell",
      "makefile",
      "toml",
      "dockerfile",
    ]) {
      expect(commentPrefix(lang)).toBe("#");
    }
  });

  it("returns -- for SQL and Lua-family languages", () => {
    for (const lang of ["lua", "sql", "haskell"]) {
      expect(commentPrefix(lang)).toBe("--");
    }
  });

  it("returns % for matlab and erlang", () => {
    for (const lang of ["matlab", "erlang"]) {
      expect(commentPrefix(lang)).toBe("%");
    }
  });

  it("returns ; for lisps", () => {
    for (const lang of ["clojure", "lisp", "scheme"]) {
      expect(commentPrefix(lang)).toBe(";");
    }
  });

  it("returns <!-- for markup languages", () => {
    for (const lang of ["html", "xml"]) {
      expect(commentPrefix(lang)).toBe("<!--");
    }
  });

  it("returns /* for css", () => {
    expect(commentPrefix("css")).toBe("/*");
  });

  it("returns // for scss and less", () => {
    for (const lang of ["scss", "less"]) {
      expect(commentPrefix(lang)).toBe("//");
    }
  });

  it("defaults to // for unknown languages", () => {
    expect(commentPrefix("unknown")).toBe("//");
    expect(commentPrefix("")).toBe("//");
  });
});

describe("extractImports", () => {
  it("completes in bounded time on pathological input", () => {
    // Long line with many spaces but no "from". Previously could cause
    // super-linear backtracking with .*? between \s+ boundaries.
    const pathological = "import " + "x ".repeat(5000) + ";";
    const t0 = performance.now();
    extractImports(pathological, "typescript");
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50); // should be <1ms, 50ms is generous
  });

  it("extracts multiline JS/TS imports", () => {
    const text = ["import {", "  foo,", "  bar", '} from "./utils";'].join("\n");

    const imports = extractImports(text, "typescript");
    expect(imports).toContain("./utils");
  });

  it("extracts multiline export-from specifiers", () => {
    const text = ["export {", "  A,", "  B", '} from "../shared";'].join("\n");

    const imports = extractImports(text, "typescript");
    expect(imports).toContain("../shared");
  });

  it("extracts side-effect imports for JS/TS", () => {
    const text = [
      'import "./polyfills";',
      'import "reflect-metadata"',
      'import { foo } from "bar";',
    ].join("\n");

    const imports = extractImports(text, "typescript");
    expect(imports).toContain("./polyfills");
    expect(imports).toContain("reflect-metadata");
    expect(imports).toContain("bar");
  });
});

describe("isImportMatch", () => {
  it("matches ./ relative imports", () => {
    expect(isImportMatch("src/utils/foo.ts", ["./foo"])).toBe(true);
  });

  it("matches ../ relative imports", () => {
    expect(isImportMatch("src/utils/foo.ts", ["../utils/foo"])).toBe(true);
  });

  it("matches deeply nested ../ imports", () => {
    expect(isImportMatch("src/utils/helpers.ts", ["../../utils/helpers"])).toBe(true);
  });

  it("does not match bare package specifiers", () => {
    expect(isImportMatch("src/react.ts", ["react"])).toBe(false);
  });

  it("does not match unrelated relative imports", () => {
    expect(isImportMatch("src/utils/foo.ts", ["./bar"])).toBe(false);
  });

  it("matches paths with backslash separators", () => {
    expect(isImportMatch(String.raw`src\utils\foo.ts`, ["./foo"])).toBe(true);
  });

  it("resolves ./ import against current file directory", () => {
    // ./foo from src/utils/index.ts → src/utils/foo
    expect(isImportMatch("src/utils/foo.ts", ["./foo"], "src/utils/index.ts")).toBe(true);
  });

  it("resolves ../ import against current file directory", () => {
    // ../utils/foo from src/other/index.ts → src/utils/foo
    expect(
      isImportMatch("src/utils/foo.ts", ["../utils/foo"], "src/other/index.ts")
    ).toBe(true);
  });

  it("rejects same-tail file from a different directory when resolved", () => {
    // ./utils from packages/a/src/index.ts → packages/a/src/utils
    // candidate is packages/b/src/utils.ts → packages/b/src/utils: no match
    expect(
      isImportMatch("packages/b/src/utils.ts", ["./utils"], "packages/a/src/index.ts")
    ).toBe(false);
  });

  it("rejects same-tail file from unrelated path when resolved", () => {
    // ./foo from src/a/index.ts → src/a/foo
    // candidate is src/b/foo.ts → src/b/foo: no match
    expect(isImportMatch("src/b/foo.ts", ["./foo"], "src/a/index.ts")).toBe(false);
  });
});

function mockSymbol(name: string, kind: number, detail = ""): vscode.DocumentSymbol {
  return {
    name,
    detail,
    kind: kind as vscode.SymbolKind,
    range: new vscode.Range(0, 0, 10, 0),
    selectionRange: new vscode.Range(0, 0, 0, name.length),
    children: [],
    tags: [],
  } as vscode.DocumentSymbol;
}

describe("formatSymbolPathContext", () => {
  it("returns empty string for empty array", () => {
    expect(formatSymbolPathContext([])).toBe("");
  });

  it("formats single symbol with kind label", () => {
    const result = formatSymbolPathContext([mockSymbol("Foo", 5)]);
    expect(result).toContain("Scope:");
    expect(result).toContain("class Foo");
  });

  it("formats nested symbols with increasing indentation", () => {
    const result = formatSymbolPathContext([
      mockSymbol("Server", 5),
      mockSymbol("handle", 6),
    ]);
    const lines = result.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("class Server");
    expect(lines[2]).toContain("method handle");
    // Inner symbol should be more indented
    const indent1 = lines[1]!.indexOf("class");
    const indent2 = lines[2]!.indexOf("method");
    expect(indent2).toBeGreaterThan(indent1);
  });

  it("includes detail when present", () => {
    const result = formatSymbolPathContext([
      mockSymbol("greet", 12, "(name: string): void"),
    ]);
    expect(result).toContain("function greet (name: string): void");
  });

  it("returns plain text without comment prefixes", () => {
    const result = formatSymbolPathContext([mockSymbol("init", 12)]);
    expect(result).toMatch(/^Scope:/);
    expect(result).not.toContain("//");
    expect(result).not.toContain("#");
  });
});

function makeTestDocument(lines: readonly string[]): vscode.TextDocument {
  const text = lines.join("\n");
  return {
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    getText: (range?: vscode.Range) => {
      if (!range) return text;
      const startLine = range.start.line;
      const endLine = range.end.line;
      const selected = lines.slice(startLine, endLine + 1);
      if (selected.length === 0) return "";
      selected[0] = selected[0]!.slice(range.start.character);
      selected[selected.length - 1] = selected
        .at(-1)!
        .slice(
          0,
          startLine === endLine
            ? range.end.character - range.start.character
            : range.end.character
        );
      return selected.join("\n");
    },
  } as unknown as vscode.TextDocument;
}

describe("extractEditedRanges", () => {
  it("clips oversized range to budget instead of dropping it", () => {
    // 40 lines, well over MAX_SNIPPET_LINES (30)
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const doc = makeTestDocument(lines);
    const history: FileEditHistory = {
      uri: {} as vscode.Uri,
      edits: [{ startLine: 0, endLine: 39, timestamp: Date.now() }],
    };

    const result = extractEditedRanges(doc, history);
    expect(result.length).toBeGreaterThan(0);
    // Should contain the first 30 lines (budget), not be empty
    expect(result).toContain("line 0");
    expect(result).toContain("line 29");
    expect(result).not.toContain("line 30");
  });

  it("clips second range when first exhausts most of the budget", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const doc = makeTestDocument(lines);
    const history: FileEditHistory = {
      uri: {} as vscode.Uri,
      edits: [
        { startLine: 0, endLine: 24, timestamp: Date.now() }, // 25 lines (with padding → capped)
        { startLine: 40, endLine: 45, timestamp: Date.now() }, // 6 lines
      ],
    };

    const result = extractEditedRanges(doc, history);
    expect(result).toContain("line 0");
    // Second range should get partial content rather than being dropped
    expect(result.length).toBeGreaterThan(0);
  });
});
