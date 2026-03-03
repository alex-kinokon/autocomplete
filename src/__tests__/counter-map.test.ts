import { describe, expect, it } from "vitest";

import { createCounterMap } from "../counter-map.ts";

describe("CounterMap", () => {
  it("returns 0 for missing keys", () => {
    const map = createCounterMap([]);
    expect(map.get("x")).toBe(0);
  });

  it("increments and decrements", () => {
    const map = createCounterMap(["a"]);
    expect(map.inc("a")).toBe(1);
    expect(map.inc("a")).toBe(2);
    expect(map.dec("a")).toBe(1);
    expect(map.get("a")).toBe(1);
  });

  it("increments keys not in the initial set", () => {
    const map = createCounterMap([]);
    expect(map.inc("new")).toBe(1);
  });

  it("decrements below zero", () => {
    const map = createCounterMap(["a"]);
    expect(map.dec("a")).toBe(-1);
  });

  it("clampNegatives resets negative values to 0", () => {
    const map = createCounterMap(["a", "b"]);
    map.dec("a");
    map.inc("b");
    map.clampNegatives();
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(1);
  });

  it("copy produces an independent snapshot", () => {
    const map = createCounterMap(["a"]);
    map.inc("a");
    const clone = map.copy();
    map.inc("a");
    expect(clone.get("a")).toBe(1);
    expect(map.get("a")).toBe(2);
  });

  it("toRecord returns a plain object", () => {
    const map = createCounterMap(["x", "y"]);
    map.inc("x");
    expect(map.toRecord()).toEqual({ x: 1, y: 0 });
  });
});
