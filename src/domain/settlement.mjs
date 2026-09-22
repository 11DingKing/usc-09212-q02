// 结算周期与账单登记：周期关账后不可重开，账单一旦出具不可修改。
export class SettlementBook {
  #periods = new Map();
  #invoices = new Map();

  #key(tenantId, period) {
    return `${tenantId}|${period}`;
  }

  isClosed(tenantId, period) {
    return this.#periods.has(this.#key(tenantId, period));
  }

  applyClosed({ tenantId, period, closedAt, invoiceId }) {
    const key = this.#key(tenantId, period);
    if (this.#periods.has(key)) return false;
    this.#periods.set(key, { tenantId, period, closedAt, invoiceId });
    return true;
  }

  applyInvoice(invoice) {
    if (this.#invoices.has(invoice.invoiceId)) return false;
    this.#invoices.set(invoice.invoiceId, invoice);
    return true;
  }

  invoice(invoiceId) {
    return this.#invoices.get(invoiceId) ?? null;
  }

  invoiceOf(tenantId, period) {
    const state = this.#periods.get(this.#key(tenantId, period));
    return state ? this.#invoices.get(state.invoiceId) : null;
  }

  invoicesOf(tenantId) {
    return [...this.#invoices.values()].filter((inv) => inv.tenantId === tenantId);
  }

  toJSON() {
    return {
      periods: [...this.#periods.values()],
      invoices: [...this.#invoices.values()],
    };
  }

  static fromJSON(state) {
    const book = new SettlementBook();
    for (const period of state?.periods ?? []) book.applyClosed(period);
    for (const invoice of state?.invoices ?? []) book.applyInvoice(invoice);
    return book;
  }
}
