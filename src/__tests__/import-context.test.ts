import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { DefinitionCache } from "../definition-cache.ts";
import {
  extractImportedNames,
  findReferencedImports,
  getDefinitionSnippets,
} from "../import-context.ts";

describe("extractImportedNames", () => {
  describe("JavaScript/TypeScript", () => {
    const langs = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

    it("extracts named imports", () => {
      const text = `import { foo, bar } from "./utils";`;
      for (const lang of langs) {
        const names = extractImportedNames(text, lang).map(s => s.name);
        expect(names).toContain("foo");
        expect(names).toContain("bar");
      }
    });

    it("extracts aliased named imports", () => {
      const text = `import { foo as myFoo, bar as myBar } from "./utils";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      expect(names).toContain("myFoo");
      expect(names).toContain("myBar");
      expect(names).not.toContain("foo");
    });

    it("extracts default imports", () => {
      const text = `import React from "react";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      expect(names).toContain("React");
    });

    it("excludes import type", () => {
      const text = `import type { Foo } from "./types";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      // "type" should not appear as an imported name
      expect(names).not.toContain("type");
      // But Foo should appear (named import inside { })
      expect(names).toContain("Foo");
    });

    it("extracts type-only default imports", () => {
      const text = `import type Foo from "./types";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      expect(names).toContain("Foo");
      expect(names).not.toContain("type");
    });

    it("extracts inline type specifiers in named imports", () => {
      const text = `import { type Bar, Baz, type Qux as Q } from "./types";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      expect(names).toContain("Bar");
      expect(names).toContain("Baz");
      expect(names).toContain("Q");
      expect(names).not.toContain("type");
      expect(names).not.toContain("Qux");
    });

    it("extracts namespace imports", () => {
      const text = `import * as path from "path";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      expect(names).toContain("path");
    });

    it("extracts CommonJS requires", () => {
      const text = `const fs = require("fs");`;
      const names = extractImportedNames(text, "javascript").map(s => s.name);
      expect(names).toContain("fs");
    });

    it("extracts destructured requires", () => {
      const text = `const { readFile, writeFile } = require("fs");`;
      const names = extractImportedNames(text, "javascript").map(s => s.name);
      expect(names).toContain("readFile");
      expect(names).toContain("writeFile");
    });

    it("extracts combined default and named imports", () => {
      const text = `import React, { useState, useEffect as ue } from "react";`;
      const names = extractImportedNames(text, "typescript").map(s => s.name);
      expect(names).toContain("React");
      expect(names).toContain("useState");
      expect(names).toContain("ue");
      expect(names).not.toContain("useEffect");
    });
  });

  describe("Python", () => {
    it("extracts from … import names", () => {
      const text = `from os.path import join, exists`;
      const names = extractImportedNames(text, "python").map(s => s.name);
      expect(names).toContain("join");
      expect(names).toContain("exists");
    });

    it("extracts aliased from … import", () => {
      const text = `from datetime import datetime as dt`;
      const names = extractImportedNames(text, "python").map(s => s.name);
      expect(names).toContain("dt");
      expect(names).not.toContain("datetime");
    });

    it("extracts module imports", () => {
      const text = `import sys`;
      const names = extractImportedNames(text, "python").map(s => s.name);
      expect(names).toContain("sys");
    });

    it("extracts aliased module imports", () => {
      const text = `import numpy as np`;
      const names = extractImportedNames(text, "python").map(s => s.name);
      expect(names).toContain("np");
      expect(names).not.toContain("numpy");
    });

    it("handles dotted module imports", () => {
      const text = `import os.path`;
      const names = extractImportedNames(text, "python").map(s => s.name);
      expect(names).toContain("path");
    });
  });

  describe("Go", () => {
    it("extracts single imports", () => {
      const text = `import "fmt"`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).toContain("fmt");
    });

    it("extracts aliased imports", () => {
      const text = `import mylog "log"`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).toContain("mylog");
    });

    it("extracts grouped imports", () => {
      const text = `import (
  "fmt"
  "os"
  "net/http"
)`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).toContain("fmt");
      expect(names).toContain("os");
      expect(names).toContain("http");
    });

    it("extracts aliased grouped imports", () => {
      const text = `import (
  myhttp "net/http"
)`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).toContain("myhttp");
    });

    it("ignores blank imports", () => {
      const text = `import _ "database/sql/driver"`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).not.toContain("_");
      expect(names).toHaveLength(0);
    });

    it("ignores blank imports in grouped form", () => {
      const text = `import (
  "fmt"
  _ "net/http/pprof"
  "os"
)`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).toContain("fmt");
      expect(names).toContain("os");
      expect(names).not.toContain("_");
      expect(names).toHaveLength(2);
    });

    it("ignores dot-imports", () => {
      const text = `import . "fmt"`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      // Dot-import merges package identifiers into caller scope.
      // We can’t know them statically, so skip entirely
      expect(names).not.toContain(".");
      expect(names).not.toContain("fmt");
      expect(names).toHaveLength(0);
    });

    it("ignores dot-imports in grouped form", () => {
      const text = `import (
  . "fmt"
  "os"
)`;
      const names = extractImportedNames(text, "go").map(s => s.name);
      expect(names).toContain("os");
      expect(names).not.toContain("fmt");
      expect(names).toHaveLength(1);
    });
  });

  describe("Rust", () => {
    it("extracts simple use statements", () => {
      const text = `use std::io::Read;`;
      const names = extractImportedNames(text, "rust").map(s => s.name);
      expect(names).toContain("Read");
    });

    it("extracts grouped use statements", () => {
      const text = `use std::io::{Read, Write};`;
      const names = extractImportedNames(text, "rust").map(s => s.name);
      expect(names).toContain("Read");
      expect(names).toContain("Write");
    });

    it("extracts aliased use statements", () => {
      const text = `use std::collections::{HashMap as Map, HashSet};`;
      const names = extractImportedNames(text, "rust").map(s => s.name);
      expect(names).toContain("Map");
      expect(names).toContain("HashSet");
      expect(names).not.toContain("HashMap");
    });
  });

  it("returns empty for unsupported languages", () => {
    const text = `#include <stdio.h>`;
    expect(extractImportedNames(text, "c")).toEqual([]);
  });
});

// findReferencedImports

function makeDocument(
  lines: readonly string[],
  uri = "file:///test.ts",
  languageId = "typescript"
): vscode.TextDocument {
  const text = lines.join("\n");
  return {
    uri: {
      toString: () => uri,
      scheme: "file",
      fsPath: uri.replace("file://", ""),
    },
    languageId,
    version: 1,
    lineCount: lines.length,
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
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  } as unknown as vscode.TextDocument;
}

describe("findReferencedImports", () => {
  it("finds imported identifiers near cursor", () => {
    const doc = makeDocument([
      'import { formatDate } from "./utils";',
      "",
      "function render() {",
      "  const d = formatDate(new Date());",
      "  console.log(d);",
      "}",
    ]);

    const importedNames = new Set(["formatDate"]);
    const results = findReferencedImports(doc, new vscode.Position(3, 15), importedNames);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("formatDate");
  });

  it("returns empty when no imports match", () => {
    const doc = makeDocument(["function foo() {", "  return 42;", "}"]);

    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 5),
      new Set(["bar"])
    );
    expect(results).toEqual([]);
  });

  it("returns empty for empty importedNames", () => {
    const doc = makeDocument(["const x = 1;"]);
    const results = findReferencedImports(doc, new vscode.Position(0, 5), new Set());
    expect(results).toEqual([]);
  });

  it("deduplicates by name", () => {
    const doc = makeDocument([
      'import { fmt } from "./fmt";',
      "fmt.Print(fmt.Sprintf())",
    ]);

    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["fmt"])
    );
    expect(results).toHaveLength(1);
  });

  it("limits results to MAX_DEFINITIONS (3)", () => {
    const doc = makeDocument([
      "import { a, b, c, d, e } from './lib';",
      "a(); b(); c(); d(); e();",
    ]);

    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["a", "b", "c", "d", "e"])
    );
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("skips identifiers inside comment lines", () => {
    const lines = ["// foo is used here in a comment", "const x = bar;"];
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["foo", "bar"])
    );
    // "foo" is in a comment line, should be skipped; "bar" should be found
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("bar");
  });

  it("skips identifiers inside string literals and inline comments", () => {
    const lines = [
      'const msg = "foo is great";',
      "const x = bar; // foo again",
      "const y = baz;",
    ];
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["foo", "bar", "baz"])
    );
    const names = results.map(r => r.name);
    // "foo" appears only inside a string and an inline comment and should be excluded
    expect(names).not.toContain("foo");
    // "bar" and "baz" are in code
    expect(names).toContain("bar");
    expect(names).toContain("baz");
  });

  it("skips identifiers inside same-line block comments", () => {
    const lines = ["const x = bar; /* foo is important */", "const y = baz;"];
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar", "baz"])
    );
    const names = results.map(r => r.name);
    // "foo" is inside a block comment and should be excluded
    expect(names).not.toContain("foo");
    // "bar" and "baz" are in code
    expect(names).toContain("bar");
    expect(names).toContain("baz");
  });

  it("strips Python inline # comments", () => {
    const lines = ["x = foo  # use bar here", "y = baz"];
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar", "baz"]),
      "python"
    );
    const names = results.map(r => r.name);
    // "bar" is inside a Python # comment and should be excluded
    expect(names).not.toContain("bar");
    // "foo" and "baz" are in code
    expect(names).toContain("foo");
    expect(names).toContain("baz");
  });

  it("does not strip # as comment for non-Python languages", () => {
    const lines = ["const color = '#fff'; // bar", "const x = foo;"];
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar"]),
      "typescript"
    );
    const names = results.map(r => r.name);
    // "bar" is inside a JS // comment and should be excluded
    expect(names).not.toContain("bar");
    // "foo" is in code
    expect(names).toContain("foo");
  });

  it("skips identifiers inside multi-line block comments", () => {
    const lines = [
      "const x = bar;",
      "/* this comment mentions foo",
      "   and also baz",
      "*/",
      "const y = qux;",
    ];
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(2, 0),
      new Set(["foo", "bar", "baz", "qux"])
    );
    const names = results.map(r => r.name);
    // "foo" and "baz" are inside a multi-line block comment and should be excluded
    expect(names).not.toContain("foo");
    expect(names).not.toContain("baz");
    // "bar" and "qux" are in code
    expect(names).toContain("bar");
    expect(names).toContain("qux");
  });

  it("skips text but preserves interpolations in multi-line template literals", () => {
    /* eslint-disable no-template-curly-in-string */
    const lines = [
      "const x = bar;",
      "const msg = `hello ${foo}",
      "  this mentions qux",
      "  done`;",
      "const y = corge;",
    ];
    /* eslint-enable no-template-curly-in-string */
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(2, 0),
      new Set(["foo", "bar", "qux", "corge"])
    );
    const names = results.map(r => r.name);
    // "foo" is inside ${} interpolation and should be found
    expect(names).toContain("foo");
    // "qux" is template text (not interpolation) and should be excluded
    expect(names).not.toContain("qux");
    // "bar" and "corge" are in regular code
    expect(names).toContain("bar");
    expect(names).toContain("corge");
  });

  it("preserves interpolations in same-line template literals", () => {
    /* eslint-disable no-template-curly-in-string */
    const lines = ["const msg = `hello ${foo} world`;", "const x = bar;"];
    /* eslint-enable no-template-curly-in-string */
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar"])
    );
    const names = results.map(r => r.name);
    // "foo" is inside ${} in a same-line template literal and should be found
    expect(names).toContain("foo");
    expect(names).toContain("bar");
  });

  it("only scans within SCAN_RADIUS lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `// line ${i}`);
    lines[0] = "formatDate"; // Far from cursor
    lines[15] = "formatDate"; // Within radius of cursor at line 12
    const doc = makeDocument(lines);

    const results = findReferencedImports(
      doc,
      new vscode.Position(12, 0),
      new Set(["formatDate"])
    );
    // Should find at line 15 (within ±5 of line 12) but not at line 0
    expect(results).toHaveLength(1);
    expect(results[0]!.position.line).toBe(15);
  });

  it("reports correct character position when identifier follows a removed string", () => {
    // "hello" is 7 chars; foo starts at column 18 in the original line
    const doc = makeDocument(['const x = "hello"; foo();']);
    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo"])
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("foo");
    // foo starts at column 19 in the original source
    expect(results[0]!.position.character).toBe(19);
  });

  it("reports correct character position after inline comment removal", () => {
    // "/* comment */" is 13 chars; bar starts at column 18 in the original
    const doc = makeDocument(["let y = 1; /* x */ bar(y);"]);
    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["bar"])
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.position.character).toBe(19);
  });

  it("does not skip Rust attribute lines starting with #", () => {
    const doc = makeDocument(["#[derive(Serialize)]", "let x = Serialize::new();"]);
    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["Serialize"]),
      "rust"
    );
    // Should find Serialize on line 0 (Rust attribute, not a comment)
    expect(results).toHaveLength(1);
    expect(results[0]!.position.line).toBe(0);
  });

  it("still skips # comment lines in Python", () => {
    const doc = makeDocument(["# foo is used here", "bar = foo()"]);
    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["foo"]),
      "python"
    );
    // Should only find foo on line 1, not line 0 (Python comment)
    expect(results).toHaveLength(1);
    expect(results[0]!.position.line).toBe(1);
  });

  it("handles escaped quotes inside string literals", () => {
    const doc = makeDocument([String.raw`const s = "foo\"bar";`, "const x = baz;"]);

    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar", "baz"])
    );
    const names = results.map(r => r.name);
    // foo and bar are inside a string with escaped quotes and should be excluded
    expect(names).not.toContain("foo");
    expect(names).not.toContain("bar");
    // baz is in code
    expect(names).toContain("baz");
  });

  it("handles escaped single quotes inside string literals", () => {
    const doc = makeDocument([String.raw`const s = 'foo\'bar';`, "const x = baz;"]);

    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar", "baz"])
    );
    const names = results.map(r => r.name);
    expect(names).not.toContain("foo");
    expect(names).not.toContain("bar");
    expect(names).toContain("baz");
  });

  it("does not skip *-prefixed code lines (pointer dereference, etc.)", () => {
    const doc = makeDocument([
      "const ptr = getPointer();",
      "*ptr = foo;",
      "const y = bar;",
    ]);

    const results = findReferencedImports(
      doc,
      new vscode.Position(1, 0),
      new Set(["foo", "bar"])
    );
    const names = results.map(r => r.name);
    // foo is on a *-prefixed line (pointer deref) and should NOT be skipped
    expect(names).toContain("foo");
    expect(names).toContain("bar");
  });

  it("treats backtick after even backslashes as unescaped", () => {
    // \\` means the backslash is escaped, so the backtick is unescaped
    // and starts a template literal. foo inside should not be found.
    // eslint-disable-next-line no-template-curly-in-string
    const doc = makeDocument(["const x = \\\\`foo ${bar}`;"]);
    const results = findReferencedImports(
      doc,
      new vscode.Position(0, 0),
      new Set(["foo", "bar"])
    );
    // foo is inside the template literal (non-interpolation) and should be blanked
    // bar is inside ${} interpolation and should be found
    const names = results.map(r => r.name);
    expect(names).toContain("bar");
    expect(names).not.toContain("foo");
  });
});

// getDefinitionSnippets

describe("getDefinitionSnippets", () => {
  let defCache: DefinitionCache;
  const mockExecuteCommand = vi.mocked(vscode.commands.executeCommand);
  const mockOpenTextDocument = vi.mocked(vscode.workspace.openTextDocument);

  function mockUri(path: string): vscode.Uri {
    return {
      scheme: "file",
      path,
      fsPath: path,
      toString: () => `file://${path}`,
    } as unknown as vscode.Uri;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    defCache = new DefinitionCache();
  });

  it("returns empty when no imports exist", async () => {
    const doc = makeDocument(["const x = 1;"], "file:///src/app.ts");

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(0, 5),
      defCache,
      new Set()
    );
    expect(result).toEqual([]);
  });

  it("resolves definition and creates snippet", async () => {
    const doc = makeDocument(
      ['import { helper } from "./utils";', "", "function main() {", "  helper();", "}"],
      "file:///src/app.ts"
    );

    const defUri = mockUri("/src/utils.ts");
    const defLocation = {
      uri: defUri,
      range: new vscode.Range(5, 0, 5, 30),
    };

    // Mock the definition lookup
    mockExecuteCommand.mockResolvedValueOnce([defLocation] as never);

    // Mock opening the definition file
    const defLines = [
      "// utils.ts",
      "",
      "",
      "export function helper() {",
      "  return 42;",
      "}",
      "",
      "export function other() {}",
    ];
    mockOpenTextDocument.mockResolvedValueOnce(
      makeDocument(defLines, "file:///src/utils.ts") as never
    );

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(3, 5),
      defCache,
      new Set()
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.relativePath).toContain("helper");
    expect(result[0]!.content.length).toBeGreaterThan(0);
  });

  it("skips self-references", async () => {
    const doc = makeDocument(
      ['import { foo } from "./self";', "foo();"],
      "file:///src/app.ts"
    );

    // Definition points back to the same file
    const selfLocation = {
      uri: {
        scheme: "file",
        path: "/src/app.ts",
        fsPath: "/src/app.ts",
        toString: () => "file:///src/app.ts",
      },
      range: new vscode.Range(0, 0, 0, 10),
    };
    mockExecuteCommand.mockResolvedValueOnce([selfLocation] as never);

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(1, 0),
      defCache,
      new Set()
    );
    expect(result).toEqual([]);
  });

  it("skips node_modules definitions", async () => {
    const doc = makeDocument(
      ['import React from "react";', "React.createElement();"],
      "file:///src/app.tsx",
      "typescriptreact"
    );

    const nodeModUri = mockUri("/node_modules/react/index.d.ts");
    const defLocation = {
      uri: nodeModUri,
      range: new vscode.Range(10, 0, 10, 20),
    };
    mockExecuteCommand.mockResolvedValueOnce([defLocation] as never);

    vi.mocked(vscode.workspace.asRelativePath).mockReturnValueOnce(
      "node_modules/react/index.d.ts" as never
    );

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(1, 0),
      defCache,
      new Set()
    );
    expect(result).toEqual([]);
  });

  it("skips files already in existingPaths", async () => {
    const doc = makeDocument(
      ['import { helper } from "./utils";', "helper();"],
      "file:///src/app.ts"
    );

    const defUri = mockUri("/src/utils.ts");
    const defLocation = {
      uri: defUri,
      range: new vscode.Range(5, 0, 5, 30),
    };
    mockExecuteCommand.mockResolvedValueOnce([defLocation] as never);

    vi.mocked(vscode.workspace.asRelativePath).mockReturnValueOnce(
      "src/utils.ts" as never
    );

    // Already included
    const existing = new Set(["src/utils.ts"]);
    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(1, 0),
      defCache,
      existing
    );
    expect(result).toEqual([]);
  });

  it("returns empty when all lookups time out", async () => {
    const doc = makeDocument(
      ['import { slow } from "./slow";', "slow();"],
      "file:///src/app.ts"
    );

    // Never-resolving lookup
    mockExecuteCommand.mockReturnValueOnce(new Promise(() => {}) as never);

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(1, 0),
      defCache,
      new Set()
    );
    expect(result).toEqual([]);
  }, 10_000);

  it("skips node_modules first location and uses valid second location", async () => {
    const doc = makeDocument(
      ['import { render } from "./renderer";', "render();"],
      "file:///src/app.ts"
    );

    const nodeModUri = mockUri("/node_modules/@types/renderer/index.d.ts");
    const srcUri = mockUri("/src/renderer.ts");
    const locations = [
      { uri: nodeModUri, range: new vscode.Range(0, 0, 0, 20) },
      { uri: srcUri, range: new vscode.Range(3, 0, 3, 30) },
    ];
    mockExecuteCommand.mockResolvedValueOnce(locations as never);

    // First location: node_modules → skipped
    vi.mocked(vscode.workspace.asRelativePath)
      .mockReturnValueOnce("node_modules/@types/renderer/index.d.ts" as never)
      // Second location: workspace source → accepted
      .mockReturnValueOnce("src/renderer.ts" as never);

    const defLines = [
      "// renderer.ts",
      "",
      "",
      "export function render() {",
      "  // render logic",
      "}",
    ];
    mockOpenTextDocument.mockResolvedValueOnce(
      makeDocument(defLines, "file:///src/renderer.ts") as never
    );

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(1, 0),
      defCache,
      new Set()
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.relativePath).toContain("renderer");
    expect(result[0]!.relativePath).not.toContain("node_modules");
  });

  it("never throws even on unexpected errors", async () => {
    const doc = {
      ...makeDocument(['import { x } from "./x";', "x();"], "file:///src/app.ts"),
      getText: () => {
        throw new Error("boom");
      },
    } as unknown as vscode.TextDocument;

    const result = await getDefinitionSnippets(
      doc,
      new vscode.Position(1, 0),
      defCache,
      new Set()
    );
    expect(result).toEqual([]);
  });
});
