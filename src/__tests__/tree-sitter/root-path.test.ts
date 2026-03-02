/* eslint-disable unicorn/string-content */
import { describe, expect, it } from "vitest";

import {
  type RootPathNode,
  formatRootPathContext,
  getRootPath,
} from "../../tree-sitter/root-path.ts";

import { MockNode, MockTree, asTree } from "./mock-tree.ts";

/**
 * Build a mock tree for:
 * ```
 * class UserService {          (class_declaration, lines 0-10)
 *   async createUser(name) {   (method_definition, lines 1-5)
 *     const x = validate();    (line 2)
 *     if (x) {                 (line 3)
 *       return x;              (line 4, cursor here)
 *     }                        (line 5)
 *   }
 *   deleteUser(id) {           (method_definition, lines 7-9)
 *     ...
 *   }
 * }
 * ```
 */
function makeTree(): MockTree {
  const innerBody = new MockNode({
    type: "return_statement",
    startRow: 4,
    startCol: 6,
    endRow: 4,
    endCol: 15,
    text: "return x;",
  });
  const method = new MockNode({
    type: "method_definition",
    startRow: 1,
    startCol: 2,
    endRow: 6,
    endCol: 3,
    text: "async createUser(name) {\n    const x = validate();\n    if (x) {\n      return x;\n    }\n  }",
    children: [innerBody],
  });
  const method2 = new MockNode({
    type: "method_definition",
    startRow: 7,
    startCol: 2,
    endRow: 9,
    endCol: 3,
    text: "deleteUser(id) {\n    ...\n  }",
    children: [],
  });
  const classDecl = new MockNode({
    type: "class_declaration",
    startRow: 0,
    startCol: 0,
    endRow: 10,
    endCol: 1,
    text: "class UserService {\n  async createUser(name) {\n    ...\n  }\n}",
    children: [method, method2],
  });
  const root = new MockNode({
    type: "program",
    startRow: 0,
    endRow: 10,
    endCol: 1,
    children: [classDecl],
  });

  return new MockTree(root);
}

describe("getRootPath", () => {
  it("returns innermost-to-outermost scope path", () => {
    const tree = makeTree();
    const path = getRootPath(asTree(tree), 4, 8);

    expect(path).toHaveLength(2);
    // First element is innermost (method_definition)
    expect(path[0]!.type).toBe("method_definition");
    expect(path[0]!.signature).toBe("async createUser(name) {");
    expect(path[0]!.startLine).toBe(1);
    // Second element is outermost (class_declaration)
    expect(path[1]!.type).toBe("class_declaration");
    expect(path[1]!.signature).toBe("class UserService {");
    expect(path[1]!.startLine).toBe(0);
  });

  it("returns empty array when cursor is at program root", () => {
    const root = new MockNode({
      type: "program",
      startRow: 0,
      endRow: 0,
      text: "",
    });
    const tree = new MockTree(root);
    const path = getRootPath(asTree(tree), 0, 0);
    expect(path).toEqual([]);
  });

  it("extracts first line as signature for multi-line nodes", () => {
    const tree = makeTree();
    const path = getRootPath(asTree(tree), 4, 8);
    // method_definition has multi-line text, signature should be first line only
    expect(path[0]!.signature).not.toContain("\n");
  });

  it("does not duplicate nodes", () => {
    const tree = makeTree();
    const path = getRootPath(asTree(tree), 4, 8);
    const ids = path.map(n => n.type + n.startLine);
    const unique = new Set(ids);
    expect(ids).toHaveLength(unique.size);
  });

  it("finds scope for cursor in second method", () => {
    const tree = makeTree();
    const path = getRootPath(asTree(tree), 8, 4);

    // Should find method_definition (deleteUser) and class_declaration
    expect(path.some(n => n.type === "method_definition")).toBe(true);
    expect(path.some(n => n.type === "class_declaration")).toBe(true);
  });
});

describe("formatRootPathContext", () => {
  it("returns empty string for empty path", () => {
    expect(formatRootPathContext([])).toBe("");
  });

  it("formats outermost to innermost with indentation", () => {
    const path: readonly RootPathNode[] = [
      { type: "method_definition", signature: "async createUser(name) {", startLine: 1 },
      { type: "class_declaration", signature: "class UserService {", startLine: 0 },
    ];

    const result = formatRootPathContext(path);

    expect(result).toContain("Scope:");
    // Outermost first (class), innermost last (method)
    const lines = result.split("\n").filter(l => l.trim());
    expect(lines[1]).toContain("class UserService {");
    expect(lines[2]).toContain("async createUser(name) {");
  });

  it("returns plain text without comment prefixes", () => {
    const path: readonly RootPathNode[] = [
      { type: "function_definition", signature: "def foo():", startLine: 0 },
    ];

    const result = formatRootPathContext(path);
    expect(result).toMatch(/^Scope:/);
    expect(result).not.toContain("//");
    expect(result).not.toContain("#");
  });

  it("increases indentation for nested scopes", () => {
    const path: readonly RootPathNode[] = [
      { type: "method_definition", signature: "inner()", startLine: 2 },
      { type: "class_declaration", signature: "class Mid {", startLine: 1 },
      { type: "module_declaration", signature: "module Outer {", startLine: 0 },
    ];

    const result = formatRootPathContext(path);
    const lines = result.split("\n").filter(l => l.trim());
    // Reversed: module, class, method
    expect(lines[1]).toContain("module Outer {");
    expect(lines[2]).toContain("class Mid {");
    expect(lines[3]).toContain("inner()");
    // Each level is more indented than the previous
    const indent1 = lines[1]!.indexOf("module");
    const indent2 = lines[2]!.indexOf("class");
    const indent3 = lines[3]!.indexOf("inner");
    expect(indent2).toBeGreaterThan(indent1);
    expect(indent3).toBeGreaterThan(indent2);
  });
});
