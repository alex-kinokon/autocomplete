/**
 * Mock tree-sitter Node and Tree objects for unit testing.
 *
 * These mocks implement just enough of the tree-sitter API to exercise
 * truncation, validation, and root-path logic without loading WASM.
 */
import type TreeSitter from "web-tree-sitter";

let nextId = 1;

interface MockNodeInit {
  readonly type: string;
  readonly startRow: number;
  readonly startCol?: number;
  readonly endRow: number;
  readonly endCol?: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly text?: string;
  readonly isError?: boolean;
  readonly isMissing?: boolean;
  readonly children?: MockNode[];
}

export class MockNode {
  readonly id: number;
  readonly type: string;
  readonly startPosition: TreeSitter.Point;
  readonly endPosition: TreeSitter.Point;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  readonly isError: boolean;
  readonly isMissing: boolean;
  readonly children: readonly MockNode[];
  parent: MockNode | null = null;

  constructor(init: MockNodeInit) {
    this.id = nextId++;
    this.type = init.type;
    this.startPosition = { row: init.startRow, column: init.startCol ?? 0 };
    this.endPosition = { row: init.endRow, column: init.endCol ?? 0 };
    this.startIndex = init.startIndex ?? 0;
    this.endIndex = init.endIndex ?? 0;
    this.text = init.text ?? "";
    this.isError = init.isError ?? false;
    this.isMissing = init.isMissing ?? false;
    this.children = init.children ?? [];

    // Wire up parent references
    for (const child of this.children) {
      child.parent = this;
    }
  }

  descendantForPosition(position: TreeSitter.Point): MockNode | null {
    // Find the deepest node containing this position
    for (const child of this.children) {
      if (
        (child.startPosition.row < position.row ||
          (child.startPosition.row === position.row &&
            child.startPosition.column <= position.column)) &&
        (child.endPosition.row > position.row ||
          (child.endPosition.row === position.row &&
            child.endPosition.column >= position.column))
      ) {
        return child.descendantForPosition(position) ?? child;
      }
    }
    return this;
  }

  descendantsOfType(type: string): MockNode[] {
    const results: MockNode[] = [];
    if (this.type === type) results.push(this);
    for (const child of this.children) {
      results.push(...child.descendantsOfType(type));
    }
    return results;
  }
}

export class MockTree {
  readonly rootNode: MockNode;
  private deleted = false;

  constructor(rootNode: MockNode) {
    this.rootNode = rootNode;
  }

  delete(): void {
    this.deleted = true;
  }

  get isDeleted(): boolean {
    return this.deleted;
  }
}

/** Cast a MockTree to TreeSitter.Tree for use in function signatures. */
export function asTree(mock: MockTree): TreeSitter.Tree {
  return mock as unknown as TreeSitter.Tree;
}
