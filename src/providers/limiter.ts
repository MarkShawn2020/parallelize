export class Semaphore {
  readonly #max: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`Semaphore max must be a positive integer, got ${max}`);
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiters.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#max) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    // Hand the slot straight to the next waiter so a newcomer cannot jump the FIFO queue.
    if (next) next();
    else this.#active--;
  }
}
