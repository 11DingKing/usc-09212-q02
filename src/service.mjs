import { AllowanceBook } from "./domain/allowances.mjs";
import { AnomalyRegistry } from "./domain/anomalies.mjs";
import { Ledger } from "./domain/ledger.mjs";
import { PlanBook } from "./domain/plans.mjs";
import { RateBook } from "./domain/rates.mjs";
import { SettlementBook } from "./domain/settlement.mjs";
import { TenantRegistry, validateTenantSpec } from "./domain/tenants.mjs";
import { Journal, ensureDir, loadSnapshot, saveSnapshot } from "./infra/journal.mjs";
import { canonicalEvent, digest, newId, verifySignature } from "./lib/crypto.mjs";
import { isSupportedCurrency, priceMicros } from "./lib/money.mjs";
import { KeyedMutex } from "./lib/mutex.mjs";
import {
  isValidPeriod,
  nextPeriod,
  parseUtcMillis,
  periodBounds,
  periodOf,
  toIso,
  windowStartOf,
} from "./lib/time.mjs";

const DEFAULT_RATE_LIMIT = { capacity: 600, refillPerSecond: 100 };
const DEFAULT_ANOMALY = { minWindows: 6, multiplier: 5, absoluteFloorQuantity: 1_000_000, historySize: 48 };
const MAX_EVENT_QUANTITY = 1_000_000_000_000;

// 用量结算服务：从计量摄取到月底关账的完整流水线。
// 状态变更一律先写日志再应用（WAL），故障恢复后按序重放继续聚合。
export class SettlementService {
  #dataDir;
  #journal = null;
  #now;
  #windowMs;
  #anomalyConfig;

  #tenants = new TenantRegistry();
  #plans = new PlanBook();
  #rates = new RateBook();
  #allowances = new AllowanceBook();
  #ledger = new Ledger();
  #anomalies = new AnomalyRegistry();
  #settlement = new SettlementBook();

  #dedup = new Set();
  #usages = new Map();
  #usageByDedupKey = new Map();
  #usageByTenantPeriod = new Map();
  #windows = new Map();
  #windowHistory = new Map();
  #buckets = new Map();
  #disputes = new Map();
  #mutex = new KeyedMutex();

  constructor({ dataDir = null, now = () => Date.now(), windowMs = 300_000, anomaly = {} } = {}) {
    this.#dataDir = dataDir;
    this.#now = now;
    this.#windowMs = windowMs;
    this.#anomalyConfig = { ...DEFAULT_ANOMALY, ...anomaly };
  }

  static open(options = {}) {
    const service = new SettlementService(options);
    service.#recover();
    return service;
  }

  // ---------- 注册与配置 ----------

  registerTenant(spec) {
    const validation = validateTenantSpec(spec, (code) => this.#plans.get(code) !== null);
    if (!validation.ok) return { status: "invalid", reason: validation.reason };
    const tenant = {
      tenantId: spec.tenantId,
      currency: spec.currency,
      timezone: spec.timezone ?? "UTC",
      signingKey: spec.signingKey,
      planCode: spec.planCode ?? null,
      rateLimit: spec.rateLimit ?? null,
      createdAt: toIso(this.#now()),
    };
    const existing = this.#tenants.get(tenant.tenantId);
    if (existing) {
      const { createdAt: _a, ...a } = existing;
      const { createdAt: _b, ...b } = tenant;
      return JSON.stringify(a) === JSON.stringify(b)
        ? { status: "exists", tenantId: tenant.tenantId }
        : { status: "conflict", reason: "租户已存在且配置不同" };
    }
    this.#appendAndApply({ type: "tenant-registered", tenant });
    return { status: "registered", tenantId: tenant.tenantId };
  }

  registerPlan(spec) {
    if (!spec || typeof spec.code !== "string" || spec.code.length === 0) {
      return { status: "invalid", reason: "code 必填" };
    }
    if (!Number.isSafeInteger(spec.tokensPerPeriod) || spec.tokensPerPeriod <= 0) {
      return { status: "invalid", reason: "tokensPerPeriod 必须是正整数" };
    }
    const plan = {
      code: spec.code,
      modelScope: spec.modelScope ?? "*",
      tokensPerPeriod: spec.tokensPerPeriod,
      priority: Number.isSafeInteger(spec.priority) ? spec.priority : 0,
    };
    const existing = this.#plans.get(plan.code);
    if (existing) {
      return JSON.stringify(existing) === JSON.stringify(plan)
        ? { status: "exists", code: plan.code }
        : { status: "conflict", reason: "套餐已存在且内容不同" };
    }
    this.#appendAndApply({ type: "plan-registered", plan });
    return { status: "registered", code: plan.code };
  }

  publishRate(spec) {
    if (!spec || typeof spec.model !== "string" || spec.model.length === 0) {
      return { status: "invalid", reason: "model 必填" };
    }
    if (!isSupportedCurrency(spec.currency)) {
      return { status: "invalid", reason: `不支持的结算币种: ${spec.currency}` };
    }
    if (!Number.isSafeInteger(spec.microsPerThousand) || spec.microsPerThousand < 0) {
      return { status: "invalid", reason: "microsPerThousand 必须是非负整数" };
    }
    const effectiveFrom = parseUtcMillis(spec.effectiveFrom);
    if (effectiveFrom === null) return { status: "invalid", reason: "effectiveFrom 不是合法时间" };
    const rate = {
      rateId: spec.rateId ?? newId("rate"),
      model: spec.model,
      currency: spec.currency,
      microsPerThousand: spec.microsPerThousand,
      effectiveFrom,
    };
    const existing = this.#rates.get(rate.rateId);
    if (existing) {
      return JSON.stringify(existing) === JSON.stringify(rate)
        ? { status: "exists", rateId: rate.rateId }
        : { status: "conflict", reason: "费率编号已存在且内容不同" };
    }
    this.#appendAndApply({ type: "rate-published", rate });
    return { status: "published", rateId: rate.rateId };
  }

  grantAllowance(spec) {
    const tenant = this.#tenants.get(spec?.tenantId);
    if (!tenant) return { status: "unknown_tenant", tenantId: spec?.tenantId };
    if (!Number.isSafeInteger(spec.totalQuantity) || spec.totalQuantity <= 0) {
      return { status: "invalid", reason: "totalQuantity 必须是正整数" };
    }
    const startsAt = parseUtcMillis(spec.startsAt);
    const endsAt = parseUtcMillis(spec.endsAt);
    if (startsAt === null || endsAt === null || startsAt >= endsAt) {
      return { status: "invalid", reason: "有效期区间非法" };
    }
    const allowance = {
      allowanceId: newId("al"),
      tenantId: tenant.tenantId,
      modelScope: spec.modelScope ?? "*",
      totalQuantity: spec.totalQuantity,
      consumedQuantity: 0,
      startsAt,
      endsAt,
      priority: Number.isSafeInteger(spec.priority) ? spec.priority : 0,
      planCode: null,
    };
    this.#appendAndApply({ type: "allowance-granted", allowance });
    return { status: "granted", allowanceId: allowance.allowanceId };
  }

  grantCredit(tenantId, { amountMicros, reason = null, grantedBy = "operator" } = {}) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) return { status: "unknown_tenant", tenantId };
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
      return { status: "invalid", reason: "amountMicros 必须是正整数" };
    }
    const entry = {
      entryId: newId("le"),
      tenantId,
      type: "grant",
      amountMicros,
      currency: tenant.currency,
      reason,
      grantedBy,
      createdAt: toIso(this.#now()),
    };
    this.#appendAndApply({ type: "credit-entry", entry });
    return { status: "granted", entryId: entry.entryId, balanceMicros: this.#ledger.balance(tenantId) };
  }

  // ---------- 计量摄取 ----------

  async ingest(raw) {
    const receivedAt = this.#now();
    const invalid = this.#validateEvent(raw);
    if (invalid) return invalid;

    const tenant = this.#tenants.get(raw.tenantId);
    if (!tenant) return { status: "unknown_tenant", eventId: raw.eventId };

    if (!verifySignature(tenant.signingKey, canonicalEvent(raw), raw.signature)) {
      return { status: "invalid_signature", eventId: raw.eventId };
    }

    const quota = this.#acquireQuota(tenant, receivedAt);
    if (!quota.ok) {
      return { status: "throttled", eventId: raw.eventId, retryAfterMs: quota.retryAfterMs };
    }

    const occurredMs = parseUtcMillis(raw.occurredAt);
    const windowStart = windowStartOf(occurredMs, this.#windowMs);
    const dedupKey = `${raw.tenantId}|${raw.model}|${windowStart}|${raw.eventId}`;
    const seen = this.#usageByDedupKey.get(dedupKey);
    if (seen !== undefined) {
      return { status: "duplicate", eventId: raw.eventId, usageId: seen };
    }

    const rate = this.#rates.resolve(raw.model, tenant.currency, occurredMs);
    if (!rate) {
      return { status: "no_rate", eventId: raw.eventId, model: raw.model, currency: tenant.currency };
    }

    // 扣减临界区按租户串行，检查余额与扣款之间不会插入其他请求。
    return this.#mutex.run(raw.tenantId, () =>
      this.#commit({ raw, tenant, rate, occurredMs, windowStart, dedupKey, receivedAt }),
    );
  }

  async ingestBatch(events) {
    const results = [];
    for (const event of events) results.push(await this.ingest(event));
    return results;
  }

  #validateEvent(raw) {
    if (!raw || typeof raw !== "object") return { status: "invalid", reason: "事件必须是对象" };
    for (const field of ["eventId", "tenantId", "model", "occurredAt", "signature"]) {
      if (typeof raw[field] !== "string" || raw[field].length === 0) {
        return { status: "invalid", reason: `字段 ${field} 缺失或非法` };
      }
    }
    if (!Number.isSafeInteger(raw.quantity) || raw.quantity <= 0) {
      return { status: "invalid", reason: "quantity 必须是正整数" };
    }
    if (raw.quantity > MAX_EVENT_QUANTITY) {
      return { status: "invalid", reason: "quantity 超出单次事件上限" };
    }
    if (raw.unit !== undefined && raw.unit !== "token") {
      return { status: "invalid", reason: "仅支持 unit=token" };
    }
    if (parseUtcMillis(raw.occurredAt) === null) {
      return { status: "invalid", reason: "occurredAt 不是合法时间" };
    }
    return null;
  }

  #commit({ raw, tenant, rate, occurredMs, windowStart, dedupKey, receivedAt }) {
    // 等待锁期间可能已有相同事件提交，进入临界区后复查。
    const seen = this.#usageByDedupKey.get(dedupKey);
    if (seen !== undefined) return { status: "duplicate", eventId: raw.eventId, usageId: seen };

    this.#ensurePlanAllowance(tenant, occurredMs);

    // 套餐额度优先抵扣，剩余部分才按费率计价。
    let billableQuantity = raw.quantity;
    const consumptions = [];
    for (const allowance of this.#allowances.activeFor(tenant.tenantId, raw.model, occurredMs)) {
      if (billableQuantity === 0) break;
      const take = Math.min(allowance.totalQuantity - allowance.consumedQuantity, billableQuantity);
      if (take > 0) {
        consumptions.push({ allowanceId: allowance.allowanceId, quantity: take });
        billableQuantity -= take;
      }
    }

    let amountMicros;
    try {
      amountMicros = priceMicros(billableQuantity, rate.microsPerThousand);
    } catch {
      return { status: "invalid", eventId: raw.eventId, reason: "计费金额超出安全范围" };
    }

    const balanceMicros = this.#ledger.balance(tenant.tenantId);
    if (amountMicros > balanceMicros) {
      // 预付额度不可透支：事件被拒绝且不计入去重，充值后可原样重试。
      return {
        status: "insufficient_funds",
        eventId: raw.eventId,
        balanceMicros,
        requiredMicros: amountMicros,
        currency: tenant.currency,
      };
    }

    // 迟到事件路由：原周期已关账则进入下一个未关账周期，并保留原周期关联。
    const originalPeriod = periodOf(occurredMs);
    let targetPeriod = originalPeriod;
    while (this.#settlement.isClosed(tenant.tenantId, targetPeriod)) {
      targetPeriod = nextPeriod(targetPeriod);
    }

    const usage = {
      usageId: newId("u"),
      eventId: raw.eventId,
      tenantId: tenant.tenantId,
      model: raw.model,
      occurredAt: raw.occurredAt,
      receivedAt: toIso(receivedAt),
      windowStart,
      quantity: raw.quantity,
      allowanceQuantity: raw.quantity - billableQuantity,
      billableQuantity,
      amountMicros,
      currency: tenant.currency,
      rateId: rate.rateId,
      originalPeriod,
      targetPeriod,
      late: targetPeriod !== originalPeriod,
      signature: raw.signature,
    };
    const debit =
      amountMicros > 0
        ? {
            entryId: newId("le"),
            tenantId: tenant.tenantId,
            type: "debit",
            amountMicros: -amountMicros,
            currency: tenant.currency,
            usageId: usage.usageId,
            createdAt: usage.receivedAt,
          }
        : null;

    this.#appendAndApply({ type: "usage-accepted", dedupKey, usage, consumptions, debit });
    this.#detectAnomaly(usage);

    return {
      status: "accepted",
      eventId: raw.eventId,
      usageId: usage.usageId,
      period: targetPeriod,
      late: usage.late,
      amountMicros,
      currency: tenant.currency,
      allowanceQuantity: usage.allowanceQuantity,
      billableQuantity,
    };
  }

  // 订阅套餐的租户在每个结算周期首次用量时惰性生成当期额度包。
  #ensurePlanAllowance(tenant, occurredMs) {
    if (!tenant.planCode) return;
    const plan = this.#plans.get(tenant.planCode);
    if (!plan) return;
    const period = periodOf(occurredMs);
    const allowanceId = `plan:${tenant.tenantId}:${plan.code}:${period}`;
    if (this.#allowances.get(allowanceId)) return;
    const { startMs, endMs } = periodBounds(period);
    this.#appendAndApply({
      type: "allowance-granted",
      allowance: {
        allowanceId,
        tenantId: tenant.tenantId,
        modelScope: plan.modelScope,
        totalQuantity: plan.tokensPerPeriod,
        consumedQuantity: 0,
        startsAt: startMs,
        endsAt: endMs,
        priority: plan.priority,
        planCode: plan.code,
      },
    });
  }

  #acquireQuota(tenant, nowMs) {
    const limit = tenant.rateLimit ?? DEFAULT_RATE_LIMIT;
    let bucket = this.#buckets.get(tenant.tenantId);
    if (!bucket) {
      bucket = { tokens: limit.capacity, updatedAt: nowMs };
      this.#buckets.set(tenant.tenantId, bucket);
    }
    const elapsed = Math.max(0, nowMs - bucket.updatedAt);
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + (elapsed / 1000) * limit.refillPerSecond);
    bucket.updatedAt = nowMs;
    if (bucket.tokens < 1) {
      const retryAfterMs =
        limit.refillPerSecond > 0 ? Math.ceil(((1 - bucket.tokens) / limit.refillPerSecond) * 1000) : null;
      return { ok: false, retryAfterMs };
    }
    bucket.tokens -= 1;
    return { ok: true };
  }

  // 异常峰值：窗口累计量超过 max(绝对下限, 滚动基线 × 倍数) 时开立待处理异常。
  // 被标记的窗口不进入基线，避免污染后续检测。
  #detectAnomaly(usage) {
    if (this.#anomalies.forWindow(usage.tenantId, usage.model, usage.windowStart)) return;
    const config = this.#anomalyConfig;
    const total = this.#windows.get(this.#windowKey(usage.tenantId, usage.model, usage.windowStart))?.quantity ?? 0;
    const { mean, count } = this.#baselineOf(usage.tenantId, usage.model, usage.windowStart);
    const threshold =
      count >= config.minWindows
        ? Math.max(config.absoluteFloorQuantity, Math.ceil(mean * config.multiplier))
        : config.absoluteFloorQuantity;
    if (total <= threshold) return;
    this.#appendAndApply({
      type: "anomaly-opened",
      anomaly: {
        anomalyId: newId("an"),
        tenantId: usage.tenantId,
        model: usage.model,
        windowStart: usage.windowStart,
        observedQuantity: total,
        baselineQuantity: Math.round(mean),
        thresholdQuantity: threshold,
        status: "pending_review",
        openedAt: toIso(this.#now()),
      },
    });
  }

  #baselineOf(tenantId, model, excludeWindowStart) {
    const history = this.#windowHistory.get(`${tenantId}|${model}`);
    if (!history) return { mean: 0, count: 0 };
    const samples = [...history.entries()]
      .filter(([ws]) => ws !== excludeWindowStart && !this.#anomalies.forWindow(tenantId, model, ws))
      .sort((a, b) => a[0] - b[0])
      .slice(-this.#anomalyConfig.historySize)
      .map(([, quantity]) => quantity);
    if (samples.length === 0) return { mean: 0, count: 0 };
    return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, count: samples.length };
  }

  // ---------- 关账与账单 ----------

  async closePeriod(period, tenantId = null) {
    if (!isValidPeriod(period)) return { status: "invalid", reason: "周期格式应为 YYYY-MM" };
    if (periodBounds(period).endMs > this.#now()) {
      return { status: "period_not_ended", period };
    }
    let tenants;
    if (tenantId === null) {
      tenants = this.#tenants.list();
    } else {
      const tenant = this.#tenants.get(tenantId);
      if (!tenant) return { status: "unknown_tenant", tenantId };
      tenants = [tenant];
    }

    const results = [];
    const invoices = [];
    for (const tenant of tenants) {
      // 与摄取共用同一把租户锁：关账快照与后续写入不会交错，
      // 关账后到达的迟到事件只会进入下一周期。
      const outcome = await this.#mutex.run(tenant.tenantId, () => this.#closeTenantPeriod(tenant, period));
      results.push(outcome.result);
      if (outcome.invoice) invoices.push(outcome.invoice);
    }
    this.checkpoint();
    return { status: "closed", period, results, invoices };
  }

  #closeTenantPeriod(tenant, period) {
    const existing = this.#settlement.invoiceOf(tenant.tenantId, period);
    if (existing) {
      return { result: { tenantId: tenant.tenantId, period, alreadyClosed: true, invoiceId: existing.invoiceId }, invoice: null };
    }
    const usages = this.#usagesOf(tenant.tenantId, period);
    const byModel = new Map();
    for (const usage of usages) {
      const group = byModel.get(usage.model) ?? [];
      group.push(usage);
      byModel.set(usage.model, group);
    }
    const lines = [...byModel.entries()].map(([model, list]) => {
      const evidenceDigest = digest(
        list
          .map((u) => `${u.eventId}:${u.signature}`)
          .sort()
          .join("\n"),
      );
      return {
        lineId: newId("ln"),
        model,
        quantity: list.reduce((sum, u) => sum + u.quantity, 0),
        allowanceQuantity: list.reduce((sum, u) => sum + u.allowanceQuantity, 0),
        billableQuantity: list.reduce((sum, u) => sum + u.billableQuantity, 0),
        amountMicros: list.reduce((sum, u) => sum + u.amountMicros, 0),
        rateIds: [...new Set(list.map((u) => u.rateId))].sort(),
        usageIds: list.map((u) => u.usageId).sort(),
        evidenceDigest,
        lateUsageCount: list.filter((u) => u.late).length,
        anomalyIds: this.#anomalyIdsOf(list),
      };
    });
    const invoice = {
      invoiceId: newId("inv"),
      tenantId: tenant.tenantId,
      period,
      currency: tenant.currency,
      lines,
      totalMicros: lines.reduce((sum, line) => sum + line.amountMicros, 0),
      usageCount: usages.length,
      lateUsageCount: usages.filter((u) => u.late).length,
      issuedAt: toIso(this.#now()),
      status: "issued",
    };
    const closedAt = toIso(this.#now());
    this.#appendAndApply({ type: "invoice-issued", invoice });
    this.#appendAndApply({ type: "period-closed", tenantId: tenant.tenantId, period, closedAt, invoiceId: invoice.invoiceId });
    return {
      result: { tenantId: tenant.tenantId, period, alreadyClosed: false, invoiceId: invoice.invoiceId },
      invoice,
    };
  }

  #anomalyIdsOf(usages) {
    const ids = new Set();
    for (const usage of usages) {
      const anomaly = this.#anomalies.forWindow(usage.tenantId, usage.model, usage.windowStart);
      if (anomaly) ids.add(anomaly.anomalyId);
    }
    return [...ids].sort();
  }

  invoiceOf(invoiceId) {
    const invoice = this.#settlement.invoice(invoiceId);
    return invoice ? { status: "ok", invoice } : { status: "not_found", invoiceId };
  }

  invoicesOf(tenantId) {
    if (!this.#tenants.get(tenantId)) return { status: "unknown_tenant", tenantId };
    return { status: "ok", tenantId, invoices: this.#settlement.invoicesOf(tenantId) };
  }

  // 账单行 → 签名计量证据：逐条展开，供对账方核验。
  invoiceEvidence(invoiceId) {
    const invoice = this.#settlement.invoice(invoiceId);
    if (!invoice) return { status: "not_found", invoiceId };
    return {
      status: "ok",
      invoiceId,
      tenantId: invoice.tenantId,
      period: invoice.period,
      lines: invoice.lines.map((line) => ({
        lineId: line.lineId,
        model: line.model,
        evidenceDigest: line.evidenceDigest,
        events: line.usageIds
          .map((id) => this.#usages.get(id))
          .filter(Boolean)
          .map((u) => ({
            eventId: u.eventId,
            occurredAt: u.occurredAt,
            receivedAt: u.receivedAt,
            quantity: u.quantity,
            billableQuantity: u.billableQuantity,
            amountMicros: u.amountMicros,
            currency: u.currency,
            rateId: u.rateId,
            late: u.late,
            originalPeriod: u.originalPeriod,
            signature: u.signature,
          })),
      })),
    };
  }

  // 重新计算每行证据摘要并与出账时记录比对。
  verifyInvoice(invoiceId) {
    const invoice = this.#settlement.invoice(invoiceId);
    if (!invoice) return { status: "not_found", invoiceId };
    const lines = invoice.lines.map((line) => {
      const usages = line.usageIds.map((id) => this.#usages.get(id));
      const recomputed = usages.every(Boolean)
        ? digest(usages.map((u) => `${u.eventId}:${u.signature}`).sort().join("\n"))
        : null;
      return { lineId: line.lineId, valid: recomputed !== null && recomputed === line.evidenceDigest };
    });
    return { status: "ok", invoiceId, valid: lines.every((line) => line.valid), lines };
  }

  // ---------- 争议与异常处理 ----------

  // 争议更正：生成与原条目金额相反的冲正条目，原始条目与账单保持不动。
  async openDispute({ tenantId, entryId = null, usageId = null, reason = null, openedBy = "operator" } = {}) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) return { status: "unknown_tenant", tenantId };
    return this.#mutex.run(tenantId, () => {
      let target = null;
      if (entryId) target = this.#ledger.get(entryId);
      else if (usageId) target = this.#ledger.debitOfUsage(usageId);
      if (!target || target.tenantId !== tenantId) return { status: "not_found" };
      if (target.type === "reversal") return { status: "invalid", reason: "不能对冲正条目再冲正" };
      const existing = this.#ledger.reversalOf(target.entryId);
      if (existing) {
        return { status: "already_reversed", reversalEntryId: existing.entryId };
      }
      const now = toIso(this.#now());
      const disputeId = newId("dp");
      const reversal = {
        entryId: newId("le"),
        tenantId,
        type: "reversal",
        amountMicros: -target.amountMicros,
        currency: target.currency,
        reversesEntryId: target.entryId,
        disputeId,
        reason,
        createdAt: now,
      };
      if (this.#ledger.balance(tenantId) + reversal.amountMicros < 0) {
        return { status: "invalid", reason: "冲正会导致余额为负" };
      }
      const dispute = {
        disputeId,
        tenantId,
        targetEntryId: target.entryId,
        usageId: target.usageId ?? null,
        reason,
        openedBy,
        status: "corrected",
        reversalEntryId: reversal.entryId,
        openedAt: now,
        resolvedAt: now,
      };
      this.#appendAndApply({ type: "credit-entry", entry: reversal });
      this.#appendAndApply({ type: "dispute-opened", dispute });
      return {
        status: "corrected",
        disputeId,
        reversalEntryId: reversal.entryId,
        balanceMicros: this.#ledger.balance(tenantId),
      };
    });
  }

  disputesOf(tenantId) {
    if (!this.#tenants.get(tenantId)) return { status: "unknown_tenant", tenantId };
    return {
      status: "ok",
      tenantId,
      disputes: [...this.#disputes.values()].filter((d) => d.tenantId === tenantId),
    };
  }

  // 异常峰值复核：approved 维持计费；rejected 对窗口内已扣费用逐笔冲正。
  reviewAnomaly(anomalyId, { decision, reviewer = "operator" } = {}) {
    const anomaly = this.#anomalies.get(anomalyId);
    if (!anomaly) return { status: "not_found", anomalyId };
    if (decision !== "approved" && decision !== "rejected") {
      return { status: "invalid", reason: "decision 必须是 approved 或 rejected" };
    }
    if (anomaly.status !== "pending_review") {
      return { status: "already_reviewed", anomalyId, anomalyStatus: anomaly.status };
    }
    const reversalEntryIds = [];
    if (decision === "rejected") {
      for (const usage of this.#usagesInWindow(anomaly.tenantId, anomaly.model, anomaly.windowStart)) {
        const debit = this.#ledger.debitOfUsage(usage.usageId);
        if (!debit || this.#ledger.reversalOf(debit.entryId)) continue;
        const reversal = {
          entryId: newId("le"),
          tenantId: anomaly.tenantId,
          type: "reversal",
          amountMicros: -debit.amountMicros,
          currency: debit.currency,
          reversesEntryId: debit.entryId,
          reason: `异常峰值复核拒绝: ${anomalyId}`,
          createdAt: toIso(this.#now()),
        };
        this.#appendAndApply({ type: "credit-entry", entry: reversal });
        reversalEntryIds.push(reversal.entryId);
      }
    }
    this.#appendAndApply({
      type: "anomaly-reviewed",
      anomalyId,
      decision,
      reviewer,
      decidedAt: toIso(this.#now()),
    });
    return { status: "reviewed", anomalyId, decision, reversalEntryIds };
  }

  listAnomalies({ tenantId = null, status = null } = {}) {
    return {
      status: "ok",
      anomalies: this.#anomalies.list({ tenantId, status }).map((anomaly) => ({
        ...anomaly,
        usageIds: this.#usagesInWindow(anomaly.tenantId, anomaly.model, anomaly.windowStart).map((u) => u.usageId),
        currentQuantity:
          this.#windows.get(this.#windowKey(anomaly.tenantId, anomaly.model, anomaly.windowStart))?.quantity ?? 0,
      })),
    };
  }

  // ---------- 查询 ----------

  tenantView(tenantId) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) return { status: "unknown_tenant", tenantId };
    const { signingKey: _hidden, ...view } = tenant;
    return { status: "ok", tenant: view };
  }

  balanceOf(tenantId) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) return { status: "unknown_tenant", tenantId };
    return {
      status: "ok",
      tenantId,
      currency: tenant.currency,
      balanceMicros: this.#ledger.balance(tenantId),
      allowances: this.#allowances.ofTenant(tenantId).map((a) => ({
        allowanceId: a.allowanceId,
        modelScope: a.modelScope,
        totalQuantity: a.totalQuantity,
        remainingQuantity: a.totalQuantity - a.consumedQuantity,
        startsAt: toIso(a.startsAt),
        endsAt: toIso(a.endsAt),
        planCode: a.planCode,
      })),
    };
  }

  ledgerOf(tenantId) {
    if (!this.#tenants.get(tenantId)) return { status: "unknown_tenant", tenantId };
    return { status: "ok", tenantId, entries: this.#ledger.entriesOf(tenantId) };
  }

  usageOf(tenantId, period = null) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) return { status: "unknown_tenant", tenantId };
    const target = period ?? periodOf(this.#now());
    if (!isValidPeriod(target)) return { status: "invalid", reason: "周期格式应为 YYYY-MM" };
    const byModel = new Map();
    for (const usage of this.#usagesOf(tenantId, target)) {
      let group = byModel.get(usage.model);
      if (!group) {
        group = {
          model: usage.model,
          quantity: 0,
          allowanceQuantity: 0,
          billableQuantity: 0,
          amountMicros: 0,
          currency: usage.currency,
          windows: new Map(),
        };
        byModel.set(usage.model, group);
      }
      group.quantity += usage.quantity;
      group.allowanceQuantity += usage.allowanceQuantity;
      group.billableQuantity += usage.billableQuantity;
      group.amountMicros += usage.amountMicros;
      group.windows.set(usage.windowStart, (group.windows.get(usage.windowStart) ?? 0) + usage.quantity);
    }
    const models = [...byModel.values()].map((group) => ({
      ...group,
      windows: [...group.windows.entries()]
        .map(([windowStart, quantity]) => ({ windowStart, windowStartIso: toIso(windowStart), quantity }))
        .sort((a, b) => a.windowStart - b.windowStart),
    }));
    return {
      status: "ok",
      tenantId,
      period: target,
      closed: this.#settlement.isClosed(tenantId, target),
      models,
      totalMicros: models.reduce((sum, m) => sum + m.amountMicros, 0),
      currency: tenant.currency,
    };
  }

  // ---------- 故障恢复 ----------

  checkpoint() {
    if (!this.#journal) return { status: "ephemeral" };
    saveSnapshot(this.#dataDir, {
      seq: this.#journal.seq,
      savedAt: toIso(this.#now()),
      state: this.#snapshotState(),
    });
    return { status: "checkpointed", seq: this.#journal.seq };
  }

  #recover() {
    if (!this.#dataDir) return;
    ensureDir(this.#dataDir);
    this.#journal = new Journal(this.#dataDir);
    const snapshot = loadSnapshot(this.#dataDir);
    const fromSeq = snapshot?.seq ?? 0;
    if (snapshot) this.#loadState(snapshot.state);
    for (const record of this.#journal.read()) {
      if (record.seq <= fromSeq) continue;
      this.#apply(record);
    }
  }

  #appendAndApply(record) {
    const stored = this.#journal ? this.#journal.append(record) : record;
    this.#apply(stored);
    return stored;
  }

  #apply(record) {
    switch (record.type) {
      case "tenant-registered":
        this.#tenants.apply(record.tenant);
        break;
      case "plan-registered":
        this.#plans.apply(record.plan);
        break;
      case "rate-published":
        this.#rates.apply(record.rate);
        break;
      case "allowance-granted":
        this.#allowances.apply(record.allowance);
        break;
      case "credit-entry":
        this.#ledger.apply(record.entry);
        break;
      case "usage-accepted":
        this.#applyUsageAccepted(record);
        break;
      case "anomaly-opened":
        this.#anomalies.applyOpen(record.anomaly);
        break;
      case "anomaly-reviewed":
        this.#anomalies.applyReview(record);
        break;
      case "period-closed":
        this.#settlement.applyClosed(record);
        break;
      case "invoice-issued":
        this.#settlement.applyInvoice(record.invoice);
        break;
      case "dispute-opened":
        this.#disputes.set(record.dispute.disputeId, record.dispute);
        break;
      default:
        break; // 未知记录类型：忽略，保证前向兼容
    }
  }

  #applyUsageAccepted(record) {
    if (this.#dedup.has(record.dedupKey)) return; // 重放幂等
    const { usage, consumptions = [], debit } = record;
    this.#dedup.add(record.dedupKey);
    this.#usages.set(usage.usageId, usage);
    this.#usageByDedupKey.set(record.dedupKey, usage.usageId);
    this.#indexUsage(usage);
    for (const consumption of consumptions) {
      this.#allowances.consume(consumption.allowanceId, consumption.quantity);
    }
    if (debit) this.#ledger.apply(debit);
    const windowKey = this.#windowKey(usage.tenantId, usage.model, usage.windowStart);
    const aggregate = this.#windows.get(windowKey) ?? { quantity: 0, amountMicros: 0 };
    aggregate.quantity += usage.quantity;
    aggregate.amountMicros += usage.amountMicros;
    this.#windows.set(windowKey, aggregate);
    this.#recordWindowHistory(usage, aggregate.quantity);
  }

  #recordWindowHistory(usage, windowTotal) {
    const key = `${usage.tenantId}|${usage.model}`;
    let history = this.#windowHistory.get(key);
    if (!history) {
      history = new Map();
      this.#windowHistory.set(key, history);
    }
    history.set(usage.windowStart, windowTotal);
    // 只保留近期窗口，基线计算有界。
    const keep = this.#anomalyConfig.historySize + 16;
    if (history.size > keep) {
      const sorted = [...history.keys()].sort((a, b) => a - b);
      for (const stale of sorted.slice(0, history.size - keep)) history.delete(stale);
    }
  }

  #windowKey(tenantId, model, windowStart) {
    return `${tenantId}|${model}|${windowStart}`;
  }

  #indexUsage(usage) {
    const key = `${usage.tenantId}|${usage.targetPeriod}`;
    let index = this.#usageByTenantPeriod.get(key);
    if (!index) {
      index = [];
      this.#usageByTenantPeriod.set(key, index);
    }
    index.push(usage.usageId);
  }

  #usagesOf(tenantId, period) {
    const ids = this.#usageByTenantPeriod.get(`${tenantId}|${period}`) ?? [];
    return ids.map((id) => this.#usages.get(id)).filter(Boolean);
  }

  #usagesInWindow(tenantId, model, windowStart) {
    return [...this.#usages.values()].filter(
      (u) => u.tenantId === tenantId && u.model === model && u.windowStart === windowStart,
    );
  }

  #snapshotState() {
    return {
      tenants: this.#tenants.toJSON(),
      plans: this.#plans.toJSON(),
      rates: this.#rates.toJSON(),
      allowances: this.#allowances.toJSON(),
      ledger: this.#ledger.toJSON(),
      anomalies: this.#anomalies.toJSON(),
      settlement: this.#settlement.toJSON(),
      disputes: [...this.#disputes.values()],
      dedup: [...this.#dedup],
      usageByDedupKey: [...this.#usageByDedupKey.entries()],
      usages: [...this.#usages.values()],
      windows: [...this.#windows.entries()],
      windowHistory: [...this.#windowHistory.entries()].map(([key, history]) => [key, [...history.entries()]]),
    };
  }

  #loadState(state) {
    this.#tenants = TenantRegistry.fromJSON(state.tenants);
    this.#plans = PlanBook.fromJSON(state.plans);
    this.#rates = RateBook.fromJSON(state.rates);
    this.#allowances = AllowanceBook.fromJSON(state.allowances);
    this.#ledger = Ledger.fromJSON(state.ledger);
    this.#anomalies = AnomalyRegistry.fromJSON(state.anomalies);
    this.#settlement = SettlementBook.fromJSON(state.settlement);
    this.#disputes = new Map((state.disputes ?? []).map((d) => [d.disputeId, d]));
    this.#dedup = new Set(state.dedup ?? []);
    this.#usageByDedupKey = new Map(state.usageByDedupKey ?? []);
    this.#usages = new Map((state.usages ?? []).map((u) => [u.usageId, u]));
    this.#windows = new Map(state.windows ?? []);
    this.#windowHistory = new Map((state.windowHistory ?? []).map(([key, entries]) => [key, new Map(entries)]));
    this.#usageByTenantPeriod = new Map();
    for (const usage of this.#usages.values()) this.#indexUsage(usage);
  }
}
