/**
 * Integer counter keyed by string.
 */
export class CounterMap {
  constructor(private readonly map: Map<string, number>) {}

  get(key: string): number {
    return this.map.get(key) ?? 0;
  }

  set(key: string, value: number): void {
    this.map.set(key, value);
  }

  inc(key: string): number {
    const val = this.get(key) + 1;
    this.map.set(key, val);
    return val;
  }

  dec(key: string): number {
    const val = this.get(key) - 1;
    this.map.set(key, val);
    return val;
  }

  /** Clamp every entry that went negative back to 0. */
  clampNegatives(): void {
    for (const [key, val] of this.map) {
      if (val < 0) this.map.set(key, 0);
    }
  }

  /** Shallow copy. */
  copy(): CounterMap {
    return new CounterMap(new Map(this.map));
  }

  /**
   * Convert to a plain object (useful for test assertions).
   * @internal
   */
  toRecord(): Record<string, number> {
    return Object.fromEntries(this.map);
  }
}

export function createCounterMap(keys: readonly string[]) {
  return new CounterMap(new Map(keys.map(k => [k, 0])));
}
