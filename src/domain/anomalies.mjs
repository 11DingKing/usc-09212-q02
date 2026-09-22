// 异常峰值登记：状态机 pending_review → approved | rejected。
// 拒绝时由服务层对窗口内已扣费用逐笔冲正，不在此处改历史。
export class AnomalyRegistry {
  #items = new Map();
  #byWindow = new Map();

  #key(tenantId, model, windowStart) {
    return `${tenantId}|${model}|${windowStart}`;
  }

  applyOpen(anomaly) {
    if (this.#items.has(anomaly.anomalyId)) return false;
    this.#items.set(anomaly.anomalyId, anomaly);
    this.#byWindow.set(this.#key(anomaly.tenantId, anomaly.model, anomaly.windowStart), anomaly.anomalyId);
    return true;
  }

  applyReview({ anomalyId, decision, reviewer, decidedAt }) {
    const anomaly = this.#items.get(anomalyId);
    if (!anomaly || anomaly.status !== "pending_review") return false;
    anomaly.status = decision;
    anomaly.decidedBy = reviewer;
    anomaly.decidedAt = decidedAt;
    return true;
  }

  get(anomalyId) {
    return this.#items.get(anomalyId) ?? null;
  }

  forWindow(tenantId, model, windowStart) {
    const id = this.#byWindow.get(this.#key(tenantId, model, windowStart));
    return id ? this.#items.get(id) : null;
  }

  list({ tenantId = null, status = null } = {}) {
    return [...this.#items.values()].filter(
      (a) => (tenantId === null || a.tenantId === tenantId) && (status === null || a.status === status),
    );
  }

  toJSON() {
    return [...this.#items.values()];
  }

  static fromJSON(list) {
    const registry = new AnomalyRegistry();
    for (const anomaly of list ?? []) registry.applyOpen(anomaly);
    return registry;
  }
}
