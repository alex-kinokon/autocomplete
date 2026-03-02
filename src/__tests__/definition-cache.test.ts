import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { DefinitionCache } from "../definition-cache.ts";

const mockExecuteCommand = vi.mocked(vscode.commands.executeCommand);

function mockUri(path: string): vscode.Uri {
  return {
    scheme: "file",
    path,
    fsPath: path,
    toString: () => `file://${path}`,
  } as unknown as vscode.Uri;
}

function mockLocation(path: string, line: number): vscode.Location {
  return {
    uri: mockUri(path),
    range: new vscode.Range(line, 0, line, 10),
  };
}

describe("DefinitionCache", () => {
  let cache: DefinitionCache;

  beforeEach(() => {
    vi.resetAllMocks();
    cache = new DefinitionCache();
  });

  it("calls executeCommand on cache miss and stores result", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);
    const locations = [mockLocation("/src/bar.ts", 20)];

    mockExecuteCommand.mockResolvedValueOnce(locations as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toEqual(locations);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "vscode.executeDefinitionProvider",
      uri,
      pos
    );
  });

  it("returns cached result without calling executeCommand", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);
    const locations = [mockLocation("/src/bar.ts", 20)];

    mockExecuteCommand.mockResolvedValueOnce(locations as never);
    await cache.lookup(uri, pos, 1);
    mockExecuteCommand.mockClear();

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toEqual(locations);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("invalidates on document version change", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);
    const locations1 = [mockLocation("/src/bar.ts", 20)];
    const locations2 = [mockLocation("/src/baz.ts", 30)];

    mockExecuteCommand.mockResolvedValueOnce(locations1 as never);
    await cache.lookup(uri, pos, 1);

    mockExecuteCommand.mockResolvedValueOnce(locations2 as never);
    const result = await cache.lookup(uri, pos, 2);
    expect(result).toEqual(locations2);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent requests for the same key", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);
    const locations = [mockLocation("/src/bar.ts", 20)];

    let resolveCommand!: (value: unknown) => void;
    mockExecuteCommand.mockReturnValueOnce(
      new Promise(resolve => {
        resolveCommand = resolve;
      }) as never
    );

    const p1 = cache.lookup(uri, pos, 1);
    const p2 = cache.lookup(uri, pos, 1);

    resolveCommand(locations);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(locations);
    expect(r2).toEqual(locations);
    expect(mockExecuteCommand).toHaveBeenCalledOnce();
  });

  it("does not coalesce when version changes while request is pending", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);
    const locationsV1 = [mockLocation("/src/bar.ts", 20)];
    const locationsV2 = [mockLocation("/src/baz.ts", 30)];

    let resolveV1!: (value: unknown) => void;
    mockExecuteCommand
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveV1 = resolve;
        }) as never
      )
      .mockResolvedValueOnce(locationsV2 as never);

    // Start request for version 1
    const p1 = cache.lookup(uri, pos, 1);

    // Version changed. Must NOT reuse the pending v1 request
    const p2 = cache.lookup(uri, pos, 2);

    resolveV1(locationsV1);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(locationsV1);
    expect(r2).toEqual(locationsV2);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when concurrency limit is reached", async () => {
    const locations = [mockLocation("/src/bar.ts", 20)];
    const resolvers: Array<(value: unknown) => void> = [];
    const pending: Array<Promise<unknown>> = [];

    // Saturate concurrency (5 slots)
    for (let i = 0; i < 5; i++) {
      mockExecuteCommand.mockReturnValueOnce(
        new Promise(r => {
          resolvers.push(r);
        }) as never
      );
      pending.push(
        cache.lookup(mockUri(`/src/${String(i)}.ts`), new vscode.Position(i, 0), 1)
      );
    }

    // Sixth request should be rejected
    const result = await cache.lookup(
      mockUri("/src/overflow.ts"),
      new vscode.Position(10, 0),
      1
    );
    expect(result).toBeUndefined();

    for (const resolve of resolvers) resolve(locations);
    await Promise.all(pending);
  });

  it("getCached() never triggers LSP calls", () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    const result = cache.getCached(uri, pos, 1);
    expect(result).toBeUndefined();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("getCached() returns stored result after lookup", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);
    const locations = [mockLocation("/src/bar.ts", 20)];

    mockExecuteCommand.mockResolvedValueOnce(locations as never);
    await cache.lookup(uri, pos, 1);

    const result = cache.getCached(uri, pos, 1);
    expect(result).toEqual(locations);
  });

  it("invalidate() removes all entries for a URI", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos1 = new vscode.Position(10, 5);
    const pos2 = new vscode.Position(20, 3);
    const locations = [mockLocation("/src/bar.ts", 20)];

    mockExecuteCommand.mockResolvedValue(locations as never);
    await cache.lookup(uri, pos1, 1);
    await cache.lookup(uri, pos2, 1);

    cache.invalidate(uri);

    expect(cache.getCached(uri, pos1, 1)).toBeUndefined();
    expect(cache.getCached(uri, pos2, 1)).toBeUndefined();
  });

  it("dispose() does not throw", () => {
    expect(() => cache.dispose()).not.toThrow();
  });

  it("normalizes LocationLink results to Location", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    // LocationLink has targetUri/targetRange/targetSelectionRange instead of uri/range
    const locationLink = {
      originSelectionRange: new vscode.Range(10, 5, 10, 8),
      targetUri: mockUri("/src/target.ts"),
      targetRange: new vscode.Range(0, 0, 20, 0),
      targetSelectionRange: new vscode.Range(5, 4, 5, 15),
    };
    mockExecuteCommand.mockResolvedValueOnce([locationLink] as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toHaveLength(1);
    // Should be normalized to Location shape with uri/range
    expect(result![0]!.uri.toString()).toBe("file:///src/target.ts");
    expect(result![0]!.range.start.line).toBe(5);
    expect(result![0]!.range.start.character).toBe(4);
  });

  it("handles mixed Location and LocationLink results", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    const normalLocation = mockLocation("/src/a.ts", 3);
    const locationLink = {
      targetUri: mockUri("/src/b.ts"),
      targetRange: new vscode.Range(0, 0, 10, 0),
      targetSelectionRange: new vscode.Range(7, 0, 7, 12),
    };
    mockExecuteCommand.mockResolvedValueOnce([normalLocation, locationLink] as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toHaveLength(2);
    expect(result![0]!.uri.toString()).toBe("file:///src/a.ts");
    expect(result![1]!.uri.toString()).toBe("file:///src/b.ts");
    expect(result![1]!.range.start.line).toBe(7);
  });

  it("handles single Location result (not array)", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    // Some providers return a single Location instead of an array
    const singleLocation = mockLocation("/src/target.ts", 5);
    mockExecuteCommand.mockResolvedValueOnce(singleLocation as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toHaveLength(1);
    expect(result![0]!.uri.toString()).toBe("file:///src/target.ts");
  });

  it("handles undefined result from provider", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    mockExecuteCommand.mockResolvedValueOnce(undefined as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toEqual([]);
  });

  it("handles null result from provider", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    mockExecuteCommand.mockResolvedValueOnce(null as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toEqual([]);
  });

  it("holds concurrency slot until LSP call settles, not on caller timeout", async () => {
    const resolvers: Array<(value: unknown) => void> = [];

    // Fill all 5 slots with slow-resolving commands
    for (let i = 0; i < 5; i++) {
      mockExecuteCommand.mockReturnValueOnce(
        new Promise(r => {
          resolvers.push(r);
        }) as never
      );
      // Fire-and-forget. The lookup stays in-flight
      void cache.lookup(mockUri(`/src/${String(i)}.ts`), new vscode.Position(i, 0), 1);
    }

    // Even though a caller could time out (via withTimeout in import-context),
    // the slot should still be held. Sixth request must be rejected.
    const overflow = await cache.lookup(
      mockUri("/src/overflow.ts"),
      new vscode.Position(99, 0),
      1
    );
    expect(overflow).toBeUndefined();

    // Resolve all: slots are freed
    for (const r of resolvers) r([]);
    // Let microtasks settle
    await new Promise(r => {
      setTimeout(r, 0);
    });

    // Now a new request should succeed
    mockExecuteCommand.mockResolvedValueOnce([] as never);
    const result = await cache.lookup(
      mockUri("/src/after.ts"),
      new vscode.Position(0, 0),
      1
    );
    expect(result).toEqual([]);
  });

  it("returns undefined when executeCommand fails", async () => {
    const uri = mockUri("/src/foo.ts");
    const pos = new vscode.Position(10, 5);

    mockExecuteCommand.mockRejectedValueOnce(new Error("LSP unavailable") as never);

    const result = await cache.lookup(uri, pos, 1);
    expect(result).toBeUndefined();
  });
});
