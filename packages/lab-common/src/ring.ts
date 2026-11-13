export const ERROR_RING_CAPACITY = 200;
export const LOG_RING_CAPACITY = 500;

/** Bounded in-memory list. Keeps the last `capacity` pushes, oldest dropped first. */
export class Ring<T> {
  readonly capacity: number;
  #items: T[] = [];
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
  }
  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.capacity) this.#items.splice(0, this.#items.length - this.capacity);
  }
  get size(): number {
    return this.#items.length;
  }
  /** Newest `limit` entries, oldest first. */
  latest(limit: number = this.capacity): T[] {
    const n = Math.max(0, Math.min(Math.floor(limit), this.#items.length));
    return n === 0 ? [] : this.#items.slice(this.#items.length - n);
  }
}

export interface ErrorEntry {
  time: string;
  message: string;
  frame: string;
  requestId: string;
}

export interface LogEntry {
  time: string;
  line: string;
}

export const createErrorRing = (): Ring<ErrorEntry> => new Ring<ErrorEntry>(ERROR_RING_CAPACITY);
export const createLogRing = (): Ring<LogEntry> => new Ring<LogEntry>(LOG_RING_CAPACITY);
