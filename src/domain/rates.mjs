// 费率版本簿：同一（模型, 币种）可发布多个版本，按事件时间解析，
// 新版本只影响生效时间之后的用量，历史用量价格不变。
export class RateBook {
  #byKey = new Map();
  #byId = new Map();

  apply(version) {
    if (this.#byId.has(version.rateId)) return false;
    this.#byId.set(version.rateId, version);
    const key = `${version.model}|${version.currency}`;
    const list = this.#byKey.get(key) ?? [];
    list.push(version);
    list.sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    this.#byKey.set(key, list);
    return true;
  }

  get(rateId) {
    return this.#byId.get(rateId) ?? null;
  }

  resolve(model, currency, atMs) {
    const list = this.#byKey.get(`${model}|${currency}`) ?? [];
    let best = null;
    for (const version of list) {
      if (version.effectiveFrom <= atMs && (best === null || version.effectiveFrom > best.effectiveFrom)) {
        best = version;
      }
    }
    return best;
  }

  toJSON() {
    return [...this.#byId.values()];
  }

  static fromJSON(list) {
    const book = new RateBook();
    for (const version of list ?? []) book.apply(version);
    return book;
  }
}
