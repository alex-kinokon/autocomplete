/**
 * Root-path context extraction.
 *
 * Walks from the cursor position up to the root of the AST, collecting
 * enclosing function/class/module signatures. This gives the model
 * structural awareness of where the cursor is in the codebase.
 */
import type * as TreeSitter from "web-tree-sitter";

/** A node along the root path with its type and signature text. */
export interface RootPathNode {
  readonly type: string;
  /** First line of the enclosing scope (e.g. `function foo(bar: string) {`). */
  readonly signature: string;
  readonly startLine: number;
}

/** Node types that represent meaningful scope boundaries. */
const SCOPE_TYPES = new Set([
  // Functions
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "arrow_function",
  // Classes / types
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  // Rust / Go / etc.
  "struct_item",
  "impl_item",
  "trait_item",
  "function_item",
  // Module-level
  "module_declaration",
  "namespace_declaration",
]);

/**
 * Walk from the node at `(line, col)` up to the root, collecting enclosing
 * scope nodes (functions, classes, modules).
 *
 * Returns the path from innermost to outermost scope. Nodes with signatures
 * longer than 200 characters are excluded to avoid bloating the context.
 *
 * @param tree Parsed AST of the document
 * @param line Zero-based cursor line
 * @param col Zero-based cursor column
 * @param sourceLines Pre-split source text lines, used to extract signatures
 *   without materializing full node text. Falls back to `node.text` when omitted.
 */
export function getRootPath(
  tree: TreeSitter.Tree,
  line: number,
  col: number,
  sourceLines?: readonly string[]
): RootPathNode[] {
  const path: RootPathNode[] = [];
  let node: TreeSitter.Node | null = tree.rootNode.descendantForPosition({
    row: line,
    column: col,
  });

  const seen = new Set<number>();

  while (node) {
    if (SCOPE_TYPES.has(node.type) && !seen.has(node.id)) {
      seen.add(node.id);
      const startLine = node.startPosition.row;

      // Extract the first line as the signature. When sourceLines is
      // available, index directly instead of materializing node.text
      // (which is O(node_size) for large classes/modules).
      const signature = sourceLines
        ? (sourceLines[startLine] ?? "")
        : extractFirstLine(node.text);

      // Only include if the signature is reasonably short
      if (signature.length <= 200) {
        path.push({
          type: node.type,
          signature: signature.trimEnd(),
          startLine,
        });
      }
    }
    node = node.parent;
  }

  return path;
}

/** Extract the first line from a string without allocating the full text. */
function extractFirstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx !== -1 ? text.slice(0, idx) : text;
}

/**
 * Format root-path context as a compact string for inclusion in the prompt.
 *
 * The path is reversed so the outermost scope appears first, with increasing
 * indentation for each nesting level.
 *
 * Example output (plain text; comment wrapping is applied by the caller):
 * ```
 * Scope:
 *   class UserService {
 *     async createUser(name: string) {
 * ```
 *
 * @param rootPath Scope path from innermost to outermost (as returned by {@link getRootPath})
 */
export function formatRootPathContext(rootPath: readonly RootPathNode[]): string {
  if (rootPath.length === 0) return "";

  // Reverse to show outermost → innermost
  const reversed = [...rootPath].reverse();
  let result = "Scope:\n";
  for (const [i, element] of reversed.entries()) {
    const indent = "  ".repeat(i + 1);
    result += `${indent}${element.signature}\n`;
  }
  return result;
}
