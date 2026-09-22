// 预付额度账本：只追加、不修改。更正一律通过冲正条目（reversal）完成，
// 原始条目保持不动，历史不可改写。
export class Ledger {
  #entries = new Map();
  #balances = new Map();

  apply(entry) {
    if (this.#entries.has(entry.entryId)) return false;
    this.#entries.set(entry.entryId, entry);
    this.#balances.set(entry.tenantId, (this.#balances.get(entry.tenantId) ?? 0) + entry.amountMicros);
    return true;
  }

  get(entryId) {
    return this.#entries.get(entryId) ?? null;
  }

  balance(tenantId) {
    return this.#balances.get(tenantId) ?? 0;
  }

  reversalOf(entryId) {
    for (const entry of this.#entries.values()) {
      if (entry.reversesEntryId === entryId) return entry;
    }
    return null;
  }

  debitOfUsage(usageId) {
    for (const entry of this.#entries.values()) {
      if (entry.type === "debit" && entry.usageId === usageId) return entry;
    }
    return null;
  }

  entriesOf(tenantId) {
    return [...this.#entries.values()].filter((entry) => entry.tenantId === tenantId);
  }

  toJSON() {
    return [...this.#entries.values()];
  }

  static fromJSON(list) {
    const ledger = new Ledger();
    for (const entry of list ?? []) ledger.apply(entry);
    return ledger;
  }
}
