// 套餐模板：租户订阅后，每个结算周期惰性生成对应的额度包。
export class PlanBook {
  #plans = new Map();

  apply(plan) {
    if (this.#plans.has(plan.code)) return false;
    this.#plans.set(plan.code, plan);
    return true;
  }

  get(code) {
    return this.#plans.get(code) ?? null;
  }

  toJSON() {
    return [...this.#plans.values()];
  }

  static fromJSON(list) {
    const book = new PlanBook();
    for (const plan of list ?? []) book.apply(plan);
    return book;
  }
}
