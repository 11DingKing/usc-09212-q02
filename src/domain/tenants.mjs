import { isSupportedCurrency } from "../lib/money.mjs";

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 租户注册表：结算币种、展示时区、签名密钥、套餐与限流配置。
export class TenantRegistry {
  #items = new Map();

  apply(tenant) {
    if (this.#items.has(tenant.tenantId)) return false;
    this.#items.set(tenant.tenantId, tenant);
    return true;
  }

  get(tenantId) {
    return this.#items.get(tenantId) ?? null;
  }

  list() {
    return [...this.#items.values()];
  }

  toJSON() {
    return this.list();
  }

  static fromJSON(list) {
    const registry = new TenantRegistry();
    for (const tenant of list ?? []) registry.apply(tenant);
    return registry;
  }
}

export function validateTenantSpec(spec, planExists) {
  if (!spec || typeof spec !== "object") return { ok: false, reason: "请求必须是对象" };
  if (typeof spec.tenantId !== "string" || spec.tenantId.length === 0) {
    return { ok: false, reason: "tenantId 必填" };
  }
  if (!isSupportedCurrency(spec.currency)) {
    return { ok: false, reason: `不支持的结算币种: ${spec.currency}` };
  }
  if (spec.timezone !== undefined && !isValidTimeZone(spec.timezone)) {
    return { ok: false, reason: `非法时区: ${spec.timezone}` };
  }
  if (typeof spec.signingKey !== "string" || spec.signingKey.length < 8) {
    return { ok: false, reason: "signingKey 至少 8 个字符" };
  }
  if (spec.planCode !== undefined && spec.planCode !== null && !planExists(spec.planCode)) {
    return { ok: false, reason: `套餐不存在: ${spec.planCode}` };
  }
  if (spec.rateLimit !== undefined && spec.rateLimit !== null) {
    const { capacity, refillPerSecond } = spec.rateLimit;
    if (!(capacity > 0) || !(refillPerSecond >= 0)) {
      return { ok: false, reason: "rateLimit 需要正的 capacity 与非负的 refillPerSecond" };
    }
  }
  return { ok: true };
}
