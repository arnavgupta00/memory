export class RoleSemaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("semaphore limit must be positive");
    this.#limit = limit;
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active += 1;
  }

  #release(): void {
    this.#active -= 1;
    this.#queue.shift()?.();
  }
}
