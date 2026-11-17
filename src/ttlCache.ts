// A small time-to-live cache: remembers loaded values per key for a fixed time.

export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The value under `key`, loading and storing it when missing or older than the TTL. */
  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await load();
    this.set(key, value);
    return value;
  }

  /** The last value stored under `key`, however old. */
  peek(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: V): void {
    this.entries.set(key, { at: this.now(), value });
  }
}
