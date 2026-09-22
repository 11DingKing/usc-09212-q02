// 按键串行化异步临界区：同一租户的扣减（套餐抵扣 + 预付扣款）不会交错，
// 从而保证并发请求下预付额度不被透支。
export class KeyedMutex {
  #tails = new Map();

  async run(key, fn) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
