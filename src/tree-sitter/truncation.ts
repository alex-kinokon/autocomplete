/**
 * Syntax-aware context truncation.
 *
 * Adjusts prefix/suffix boundaries to align with AST statement/declaration
 * boundaries, avoiding mid-expression cuts.
 */
import type TreeSitter from "web-tree-sitter";

/**
 * Node types that represent statement-level or declaration-level boundaries.
 * These are the "safe" places to start or end a context window without
 * cutting mid-expression. Covers JS/TS, Python, Rust, Go, Java, C/C++.
 */
const BOUNDARY_TYPES = new Set([
  // Declarations
  "function_declaration",
  "function_definition",
  "method_definition",
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "struct_item",
  "impl_item",
  "trait_item",
  "module_declaration",
  // Statements
  "expression_statement",
  "return_statement",
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "switch_statement",
  "try_statement",
  "variable_declaration",
  "lexical_declaration",
  "import_statement",
  "import_declaration",
  "export_statement",
  "assignment_statement",
  "comment",
  // Python/Go
  "decorated_definition",
  "function_definition",
  "short_var_declaration",
  "const_declaration",
  "var_declaration",
]);

/**
 * Find the best line to start the prefix at, adjusted to an AST boundary.
 *
 * Walks forward from `targetStartLine` up to `maxAdjust` lines looking for
 * the start of a statement or declaration node. This avoids cutting
 * mid-expression at the top of the context window.
 *
 * @param tree Parsed AST of the full document
 * @param targetStartLine The initial (line-count-based) start line
 * @param maxAdjust Maximum lines to look forward for a boundary
 * @returns The adjusted start line, or `targetStartLine` if no boundary found
 */
export function findPrefixBoundary(
  tree: TreeSitter.Tree,
  targetStartLine: number,
  maxAdjust = 5
): number {
  const root = tree.rootNode;
  const maxRow = root.endPosition.row;

  for (
    let line = targetStartLine;
    line <= Math.min(targetStartLine + maxAdjust, maxRow);
    line++
  ) {
    const node = root.descendantForPosition({ row: line, column: 0 });
    if (!node) continue;

    // Walk up to find a boundary node that starts on or near this line
    let current: TreeSitter.Node | null = node;
    while (current) {
      if (
        BOUNDARY_TYPES.has(current.type) &&
        current.startPosition.row >= targetStartLine &&
        current.startPosition.row <= targetStartLine + maxAdjust
      ) {
        return current.startPosition.row;
      }
      current = current.parent;
    }
  }

  // No boundary found within range, use the original target
  return targetStartLine;
}

/**
 * Find the best line to end the suffix at, adjusted to an AST boundary.
 *
 * Walks backward from `targetEndLine` up to `maxAdjust` lines looking for
 * the end of a statement or declaration node.
 *
 * @param tree Parsed AST of the full document
 * @param targetEndLine The initial (line-count-based) end line
 * @param maxAdjust Maximum lines to look backward for a boundary
 * @returns The adjusted end line, or `targetEndLine` if no boundary found
 */
export function findSuffixBoundary(
  tree: TreeSitter.Tree,
  targetEndLine: number,
  maxAdjust = 5
): number {
  const root = tree.rootNode;

  for (let line = targetEndLine; line >= Math.max(targetEndLine - maxAdjust, 0); line--) {
    const node = root.descendantForPosition({ row: line, column: 0 });
    if (!node) continue;

    // Walk up to find a boundary node that ends on or near this line
    let current: TreeSitter.Node | null = node;
    while (current) {
      if (
        BOUNDARY_TYPES.has(current.type) &&
        current.endPosition.row <= targetEndLine &&
        current.endPosition.row >= targetEndLine - maxAdjust
      ) {
        return current.endPosition.row;
      }
      current = current.parent;
    }
  }

  return targetEndLine;
}
