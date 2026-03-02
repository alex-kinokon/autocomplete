import { describe, expect, it } from "vitest";

import { findPrefixBoundary, findSuffixBoundary } from "../../tree-sitter/truncation.ts";

import { MockNode, MockTree, asTree } from "./mock-tree.ts";

/**
 * Build a mock tree for:
 * ```
 * line 0: import foo       (import_statement, lines 0-0)
 * line 1: <empty>
 * line 2: function bar() { (function_declaration, lines 2-6)
 * line 3:   const x = 1;   (lexical_declaration, lines 3-3)
 * line 4:   if (x) {       (if_statement, lines 4-5)
 * line 5:     return x;    (return_statement, lines 5-5)
 * line 6:   }
 * line 7: }
 * line 8: <empty>
 * line 9: class Baz {      (class_declaration, lines 9-11)
 * line 10:  foo() {}       (method_definition, lines 10-10)
 * line 11: }
 * ```
 */
function makeTree(): MockTree {
  const returnStmt = new MockNode({
    type: "return_statement",
    startRow: 5,
    endRow: 5,
    endCol: 13,
  });
  const ifStmt = new MockNode({
    type: "if_statement",
    startRow: 4,
    endRow: 6,
    endCol: 3,
    children: [returnStmt],
  });
  const lexDecl = new MockNode({
    type: "lexical_declaration",
    startRow: 3,
    endRow: 3,
    endCol: 14,
  });
  const funcDecl = new MockNode({
    type: "function_declaration",
    startRow: 2,
    endRow: 7,
    endCol: 1,
    children: [lexDecl, ifStmt],
  });
  const importStmt = new MockNode({
    type: "import_statement",
    startRow: 0,
    endRow: 0,
    endCol: 10,
  });
  const methodDef = new MockNode({
    type: "method_definition",
    startRow: 10,
    endRow: 10,
    endCol: 10,
  });
  const classDecl = new MockNode({
    type: "class_declaration",
    startRow: 9,
    endRow: 11,
    endCol: 1,
    children: [methodDef],
  });
  const root = new MockNode({
    type: "program",
    startRow: 0,
    endRow: 11,
    endCol: 1,
    children: [importStmt, funcDecl, classDecl],
  });

  return new MockTree(root);
}

describe("findPrefixBoundary", () => {
  it("snaps to a statement boundary within maxAdjust", () => {
    const tree = makeTree();
    // Target line 1 (empty), should snap forward to line 2 (function_declaration)
    expect(findPrefixBoundary(asTree(tree), 1)).toBe(2);
  });

  it("returns targetStartLine if already on a boundary", () => {
    const tree = makeTree();
    // Line 0 is import_statement start
    expect(findPrefixBoundary(asTree(tree), 0)).toBe(0);
  });

  it("returns targetStartLine when no boundary in range", () => {
    const tree = makeTree();
    // Line 8 is empty, no boundary within 5 lines after it...
    // Actually line 9 has class_declaration, so it should snap there
    expect(findPrefixBoundary(asTree(tree), 8)).toBe(9);
  });

  it("respects maxAdjust parameter", () => {
    const tree = makeTree();
    // Line 1, maxAdjust=0 means only check line 1 itself
    expect(findPrefixBoundary(asTree(tree), 1, 0)).toBe(1);
  });

  it("can return a line past a hypothetical cursor position (caller must clamp)", () => {
    const tree = makeTree();
    // startLine=1 (empty line), boundary snaps forward to line 2
    // (function_declaration). If the cursor were on line 1, this would
    // make startLine > position.line. The caller must clamp with Math.min.
    const result = findPrefixBoundary(asTree(tree), 1);
    expect(result).toBe(2);
    // This proves the boundary can exceed the input line
    expect(result).toBeGreaterThan(1);
  });

  it("finds inner statement boundaries", () => {
    const tree = makeTree();
    // Line 3 has lexical_declaration
    expect(findPrefixBoundary(asTree(tree), 3)).toBe(3);
  });
});

describe("findSuffixBoundary", () => {
  it("snaps to a statement boundary within maxAdjust", () => {
    const tree = makeTree();
    // Target end line 8 (empty), should snap backward to line 7 (function_declaration ends)
    expect(findSuffixBoundary(asTree(tree), 8)).toBe(7);
  });

  it("returns targetEndLine if already on a boundary", () => {
    const tree = makeTree();
    // Line 11 is class_declaration end
    expect(findSuffixBoundary(asTree(tree), 11)).toBe(11);
  });

  it("finds method_definition boundary", () => {
    const tree = makeTree();
    // Line 10 is method_definition end
    expect(findSuffixBoundary(asTree(tree), 10)).toBe(10);
  });

  it("returns targetEndLine when no boundary in range", () => {
    const tree = makeTree();
    // With maxAdjust=0 on an empty line, returns itself
    expect(findSuffixBoundary(asTree(tree), 8, 0)).toBe(8);
  });

  it("does not query negative rows near start of file", () => {
    const tree = makeTree();
    // targetEndLine=2, maxAdjust=5 → loop would go to line -3 without clamping
    expect(() => findSuffixBoundary(asTree(tree), 2)).not.toThrow();
  });
});

describe("edge clamping", () => {
  it("findPrefixBoundary does not query rows past EOF", () => {
    const tree = makeTree();
    // targetStartLine=10, maxAdjust=5 → loop would reach line 15 (EOF is 11)
    expect(() => findPrefixBoundary(asTree(tree), 10)).not.toThrow();
  });

  it("findSuffixBoundary at line 0 does not go negative", () => {
    const tree = makeTree();
    // targetEndLine=0, maxAdjust=5 → loop would go to -5 without clamping
    expect(() => findSuffixBoundary(asTree(tree), 0)).not.toThrow();
    expect(findSuffixBoundary(asTree(tree), 0)).toBe(0);
  });
});
