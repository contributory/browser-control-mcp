/** A bounded FIFO buffer that counts what it dropped instead of growing. */
export class BoundedBuffer<T> {
  private items: T[] = [];
  private droppedCount = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  }

  push(value: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
      this.droppedCount += 1;
    }
    this.items.push(value);
  }

  /** Drains the buffer. Entries older than `ttlMs` are discarded, not returned. */
  drain(now: number, ttlMs: number): { items: T[]; dropped: number } {
    const items = this.items.filter(item => {
      const at = (item as { at?: number }).at;
      return typeof at !== "number" || now - at <= ttlMs;
    });
    const dropped =
      this.droppedCount + (this.items.length - items.length);
    this.items = [];
    this.droppedCount = 0;
    return { items, dropped };
  }

  clear(): void {
    this.items = [];
    this.droppedCount = 0;
  }

  get size(): number {
    return this.items.length;
  }
}
