// 额度包（套餐抵扣）：按优先级与到期时间排序消耗，先扣额度再扣预付余额。
export class AllowanceBook {
  #items = new Map();

  apply(allowance) {
    if (this.#items.has(allowance.allowanceId)) return false;
    this.#items.set(allowance.allowanceId, allowance);
    return true;
  }

  get(allowanceId) {
    return this.#items.get(allowanceId) ?? null;
  }

  consume(allowanceId, quantity) {
    const allowance = this.#items.get(allowanceId);
    if (allowance) allowance.consumedQuantity += quantity;
  }

  // 事件时间落在有效期内、模型匹配且有余量的额度包，按优先级与到期先后消耗。
  activeFor(tenantId, model, atMs) {
    return [...this.#items.values()]
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.startsAt <= atMs &&
          atMs < a.endsAt &&
          (a.modelScope === "*" || a.modelScope === model) &&
          a.consumedQuantity < a.totalQuantity,
      )
      .sort((a, b) => a.priority - b.priority || a.endsAt - b.endsAt);
  }

  ofTenant(tenantId) {
    return [...this.#items.values()].filter((a) => a.tenantId === tenantId);
  }

  toJSON() {
    return [...this.#items.values()];
  }

  static fromJSON(list) {
    const book = new AllowanceBook();
    for (const allowance of list ?? []) book.apply(allowance);
    return book;
  }
}
