import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { SymbolCache } from "../symbol-cache.ts";

const mockExecuteCommand = vi.mocked(vscode.commands.executeCommand);

function mockUri(path: string): vscode.Uri {
  return {
    scheme: "file",
    path,
    fsPath: path,
    toString: () => `file://${path}`,
  } as unknown as vscode.Uri;
}

function mockSymbol(
  name: string,
  kind: number,
  startLine: number,
  endLine: number,
  children: vscode.DocumentSymbol[] = [],
  detail = ""
): vscode.DocumentSymbol {
  return {
    name,
    detail,
    kind: kind as vscode.SymbolKind,
    range: new vscode.Range(startLine, 0, endLine, 80),
    selectionRange: new vscode.Range(startLine, 0, startLine, name.length),
    children,
    tags: [],
  } as vscode.DocumentSymbol;
}

describe("SymbolCache", () => {
  let cache: SymbolCache;

  beforeEach(() => {
    vi.resetAllMocks();
    cache = new SymbolCache();
  });

  it("calls executeCommand on cache miss", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbols = [mockSymbol("MyClass", 5, 0, 20)];

    mockExecuteCommand.mockResolvedValueOnce(symbols as never);

    const result = await cache.getSymbols(uri, 1);
    expect(result).toEqual(symbols);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "vscode.executeDocumentSymbolProvider",
      uri
    );
  });

  it("returns cached result without calling executeCommand", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbols = [mockSymbol("MyClass", 5, 0, 20)];

    mockExecuteCommand.mockResolvedValueOnce(symbols as never);
    await cache.getSymbols(uri, 1);
    mockExecuteCommand.mockClear();

    const result = await cache.getSymbols(uri, 1);
    expect(result).toEqual(symbols);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("invalidates on version change", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbols1 = [mockSymbol("ClassA", 5, 0, 10)];
    const symbols2 = [mockSymbol("ClassB", 5, 0, 15)];

    mockExecuteCommand.mockResolvedValueOnce(symbols1 as never);
    await cache.getSymbols(uri, 1);

    mockExecuteCommand.mockResolvedValueOnce(symbols2 as never);
    const result = await cache.getSymbols(uri, 2);
    expect(result).toEqual(symbols2);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent requests for the same URI", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbols = [mockSymbol("MyClass", 5, 0, 20)];

    let resolveCommand!: (value: unknown) => void;
    mockExecuteCommand.mockReturnValueOnce(
      new Promise(resolve => {
        resolveCommand = resolve;
      }) as never
    );

    const p1 = cache.getSymbols(uri, 1);
    const p2 = cache.getSymbols(uri, 1);

    resolveCommand(symbols);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(symbols);
    expect(r2).toEqual(symbols);
    expect(mockExecuteCommand).toHaveBeenCalledOnce();
  });

  it("does not coalesce when version changes while request is pending", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbolsV1 = [mockSymbol("ClassV1", 5, 0, 10)];
    const symbolsV2 = [mockSymbol("ClassV2", 5, 0, 15)];

    let resolveV1!: (value: unknown) => void;
    mockExecuteCommand
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveV1 = resolve;
        }) as never
      )
      .mockResolvedValueOnce(symbolsV2 as never);

    const p1 = cache.getSymbols(uri, 1);
    const p2 = cache.getSymbols(uri, 2); // version changed

    resolveV1(symbolsV1);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(symbolsV1);
    expect(r2).toEqual(symbolsV2);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
  });

  it("getCached() never triggers LSP calls", () => {
    const uri = mockUri("/src/foo.ts");

    const result = cache.getCached(uri, 1);
    expect(result).toBeUndefined();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("getCached() returns stored result after getSymbols", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbols = [mockSymbol("MyClass", 5, 0, 20)];

    mockExecuteCommand.mockResolvedValueOnce(symbols as never);
    await cache.getSymbols(uri, 1);

    const result = cache.getCached(uri, 1);
    expect(result).toEqual(symbols);
  });

  it("getCached() returns undefined for wrong version", async () => {
    const uri = mockUri("/src/foo.ts");
    const symbols = [mockSymbol("MyClass", 5, 0, 20)];

    mockExecuteCommand.mockResolvedValueOnce(symbols as never);
    await cache.getSymbols(uri, 1);

    expect(cache.getCached(uri, 2)).toBeUndefined();
  });

  it("normalizes SymbolInformation[] to DocumentSymbol[]", async () => {
    const uri = mockUri("/src/foo.ts");

    // SymbolInformation has location.range instead of range, and no children
    const symbolInfo = {
      name: "myFunc",
      containerName: "",
      kind: 12, // Function
      location: {
        uri: mockUri("/src/foo.ts"),
        range: new vscode.Range(5, 0, 15, 1),
      },
    };
    mockExecuteCommand.mockResolvedValueOnce([symbolInfo] as never);

    const result = await cache.getSymbols(uri, 1);
    expect(result).toHaveLength(1);
    // Should be normalized to DocumentSymbol shape
    expect(result![0]!.name).toBe("myFunc");
    expect(result![0]!.kind).toBe(12);
    expect(result![0]!.range.start.line).toBe(5);
    expect(result![0]!.range.end.line).toBe(15);
  });

  it("builds hierarchy from flat SymbolInformation[] using range containment", async () => {
    const uri = mockUri("/src/foo.ts");

    // Flat SymbolInformation[]: class (0-20) > method (5-15) > inner function (8-12)
    const symbolInfos = [
      {
        name: "MyClass",
        containerName: "",
        kind: 5, // Class
        location: { uri, range: new vscode.Range(0, 0, 20, 1) },
      },
      {
        name: "handleRequest",
        containerName: "MyClass",
        kind: 6, // Method
        location: { uri, range: new vscode.Range(5, 0, 15, 1) },
      },
      {
        name: "helper",
        containerName: "handleRequest",
        kind: 12, // Function
        location: { uri, range: new vscode.Range(8, 0, 12, 1) },
      },
    ];
    mockExecuteCommand.mockResolvedValueOnce(symbolInfos as never);

    const result = await cache.getSymbols(uri, 1);
    // Should build hierarchy: MyClass > handleRequest > helper
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("MyClass");
    expect(result![0]!.children).toHaveLength(1);
    expect(result![0]!.children[0]!.name).toBe("handleRequest");
    expect(result![0]!.children[0]!.children).toHaveLength(1);
    expect(result![0]!.children[0]!.children[0]!.name).toBe("helper");
  });

  it("getEnclosingSymbolPath works with hierarchical SymbolInformation[]", async () => {
    const uri = mockUri("/src/foo.ts");

    const symbolInfos = [
      {
        name: "Server",
        containerName: "",
        kind: 5, // Class
        location: { uri, range: new vscode.Range(0, 0, 30, 1) },
      },
      {
        name: "listen",
        containerName: "Server",
        kind: 6, // Method
        location: { uri, range: new vscode.Range(10, 0, 25, 1) },
      },
    ];
    mockExecuteCommand.mockResolvedValueOnce(symbolInfos as never);

    const result = await cache.getSymbols(uri, 1);
    const path = cache.getEnclosingSymbolPath(result!, new vscode.Position(15, 0));
    expect(path).toHaveLength(2);
    expect(path[0]!.name).toBe("Server");
    expect(path[1]!.name).toBe("listen");
  });

  it("handles undefined result from provider", async () => {
    const uri = mockUri("/src/foo.ts");

    mockExecuteCommand.mockResolvedValueOnce(undefined as never);

    const result = await cache.getSymbols(uri, 1);
    expect(result).toEqual([]);
  });

  it("handles null result from provider", async () => {
    const uri = mockUri("/src/foo.ts");

    mockExecuteCommand.mockResolvedValueOnce(null as never);

    const result = await cache.getSymbols(uri, 1);
    expect(result).toEqual([]);
  });

  it("returns undefined when executeCommand fails", async () => {
    const uri = mockUri("/src/foo.ts");

    mockExecuteCommand.mockRejectedValueOnce(new Error("No provider") as never);

    const result = await cache.getSymbols(uri, 1);
    expect(result).toBeUndefined();
  });

  it("dispose() does not throw", () => {
    expect(() => cache.dispose()).not.toThrow();
  });

  describe("getEnclosingSymbolPath", () => {
    it("returns empty array when no symbol contains position", () => {
      const symbols = [mockSymbol("foo", 12, 0, 5)];
      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(10, 0));
      expect(path).toEqual([]);
    });

    it("returns single-element path for flat containment", () => {
      const fn = mockSymbol("myFunc", 12, 0, 10);
      const symbols = [fn];
      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(5, 0));
      expect(path).toHaveLength(1);
      expect(path[0]!.name).toBe("myFunc");
    });

    it("returns nested path from outermost to innermost", () => {
      const method = mockSymbol("handleRequest", 6, 5, 15);
      const cls = mockSymbol("Server", 5, 0, 20, [method]);
      const symbols = [cls];

      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(10, 0));
      expect(path).toHaveLength(2);
      expect(path[0]!.name).toBe("Server");
      expect(path[1]!.name).toBe("handleRequest");
    });

    it("returns deeply nested path", () => {
      const innerFn = mockSymbol("helper", 12, 10, 14);
      const method = mockSymbol("process", 6, 5, 18, [innerFn]);
      const cls = mockSymbol("Worker", 5, 0, 25, [method]);
      const symbols = [cls];

      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(12, 0));
      expect(path).toHaveLength(3);
      expect(path[0]!.name).toBe("Worker");
      expect(path[1]!.name).toBe("process");
      expect(path[2]!.name).toBe("helper");
    });

    it("skips non-scope symbol kinds", () => {
      // Kind 8 = Field, not in SCOPE_SYMBOL_KINDS
      const field = mockSymbol("myField", 8, 5, 5);
      const cls = mockSymbol("MyClass", 5, 0, 10, [field]);
      const symbols = [cls];

      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(5, 0));
      expect(path).toHaveLength(1);
      expect(path[0]!.name).toBe("MyClass");
    });

    it("descends through non-scope parent to find nested scope children", () => {
      // Variable (kind 13) contains a Function (kind 12):
      // const handler = function() { ... }
      const innerFn = mockSymbol("handler", 12, 2, 8);
      // Kind 13 = Variable, not a scope kind
      const variable = mockSymbol("handler", 13, 0, 10, [innerFn]);
      const symbols = [variable];

      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(5, 0));
      // Should find the Function even though Variable is not a scope kind
      expect(path).toHaveLength(1);
      expect(path[0]!.name).toBe("handler");
      expect(path[0]!.kind).toBe(12); // Function
    });

    it("descends through multiple non-scope layers", () => {
      // Property (kind 7) > Variable (kind 13) > Function (kind 12)
      const fn = mockSymbol("callback", 12, 4, 8);
      const variable = mockSymbol("obj", 13, 2, 9, [fn]);
      const property = mockSymbol("exports", 7, 0, 10, [variable]);
      const symbols = [property];

      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(6, 0));
      expect(path).toHaveLength(1);
      expect(path[0]!.name).toBe("callback");
    });

    it("includes scope parent and descends through non-scope to find nested scope", () => {
      // Class (scope) > Property (non-scope) > Function (scope)
      const fn = mockSymbol("getter", 12, 5, 8);
      const property = mockSymbol("value", 7, 3, 9, [fn]);
      const cls = mockSymbol("MyClass", 5, 0, 12, [property]);
      const symbols = [cls];

      const path = cache.getEnclosingSymbolPath(symbols, new vscode.Position(6, 0));
      expect(path).toHaveLength(2);
      expect(path[0]!.name).toBe("MyClass");
      expect(path[1]!.name).toBe("getter");
    });
  });
});
