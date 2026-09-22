import { randomUUID } from "node:crypto";
import { Journal } from "./lib/journal.mjs";
import { signPayload, verifyPayload } from "./lib/sign.mjs";
import { TokenBucket } from "./lib/tokenbucket.mjs";
import {
  assertValidTimezone,
  nextPeriodId,
  periodIdFor,
  windowStartOf,
} from "./lib/time.mjs";

export const MICRO = 1_000_000; // 金额以百万分之一货币单位（micro）存储，避免浮点误差
export const DEFAULT_WINDOW_MS = 60_000;

export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_PROFILE = Object.freeze({
  settlementTimezone: "UTC",
  settlementCurrency: "USD",
  rateLimit: { capacity: 120, refillPerSec: 20 },
  anomaly: { multiplier: 5, floorTokens: 1_000_000, baselineWindows: 24, minBaseline: 3 },
});

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION", `字段 ${field} 必须是非空字符串`);
  }
  return value;
}

function requireTokenCount(value, field) {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new DomainError("VALIDATION", `字段 ${field} 必须是非负整数`);
  }
  return n;
}

function parseInstant(value, field) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new DomainError("VALIDATION", `字段 ${field} 必须是可解析的时间串`);
  }
  return ms;
}

function toMicro(amount, field) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new DomainError("VALIDATION", `字段 ${field} 必须是非负数值`);
  }
  return Math.round(amount * MICRO);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

/**
 * 用量结算服务：计量事件摄入（可乱序、可重放）、去重与归属、套餐抵扣、
 * 预付钱包（并发安全、不可透支）、费率版本、多币种结算、冲正、关账与
 * 迟到事件归集、签名计量证据、异常峰值处置。
 *
 * 所有变更先写入追加日志再应用到内存状态；重启后重放日志即可恢复。
 * 派生结果（计价、抵扣拆分、周期路由）在写入时一次性计算并随记录持久化，
 * 重放是确定性的纯合并，不会重复扣款。
 */
export class SettlementService {
  constructor(options = {}) {
    this.signingKey = options.signingKey ?? process.env.SETTLEMENT_SIGNING_KEY ?? "dev-signing-key";
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.journal = Journal.open(options.dataDir);

    this.tenants = new Map(); // tenantId -> profile
    this.rateCards = new Map(); // model -> [rateCard]（按生效时间升序）
    this.fxRates = new Map(); // "BASE:QUOTE" -> [fxRate]
    this.plans = new Map(); // planId -> plan
    this.subscriptions = new Map(); // tenantId -> subscription
    this.wallets = new Map(); // tenantId -> Map<currency, balanceMicro>
    this.topupRefs = new Map(); // `${tenantId}:${reference}` -> topupId
    this.events = new Map(); // `${tenantId}:${eventId}` -> 计量事件（含派生归属）
    this.evidence = new Map(); // `${tenantId}:${eventId}` -> {payload, signature}
    this.windows = new Map(); // `${tenantId}|${model}|${windowStart}` -> 窗口聚合
    this.planUsage = new Map(); // `${tenantId}|${periodId}|${model}` -> 已抵扣词元
    this.periods = new Map(); // `${tenantId}|${periodId}` -> {status, ...}
    this.invoices = new Map(); // invoiceId -> invoice
    this.anomalies = new Map(); // anomalyId -> anomaly
    this.anomalyIndex = new Map(); // `${tenantId}|${model}|${windowStart}` -> anomalyId
    this.ledger = []; // 追加式账目：topup / charge / reversal，永不改写
    this.buckets = new Map(); // tenantId -> TokenBucket（运行时限流状态）

    for (const record of this.journal.readAll()) {
      this._apply(record);
    }
  }

  // ---------- 租户与价目 ----------

  upsertTenant(tenantId, profile = {}) {
    requireString(tenantId, "tenantId");
    const existing = this.tenants.get(tenantId) ?? { id: tenantId, ...clone(DEFAULT_PROFILE) };
    const merged = {
      ...existing,
      ...(profile.settlementTimezone !== undefined
        ? { settlementTimezone: profile.settlementTimezone }
        : {}),
      ...(profile.settlementCurrency !== undefined
        ? { settlementCurrency: profile.settlementCurrency }
        : {}),
      rateLimit: { ...existing.rateLimit, ...(profile.rateLimit ?? {}) },
      anomaly: { ...existing.anomaly, ...(profile.anomaly ?? {}) },
    };
    try {
      assertValidTimezone(merged.settlementTimezone);
    } catch {
      throw new DomainError("VALIDATION", `非法时区: ${merged.settlementTimezone}`);
    }
    if (!/^[A-Z]{3}$/.test(merged.settlementCurrency)) {
      throw new DomainError("VALIDATION", `非法结算币种: ${merged.settlementCurrency}`);
    }
    merged.updatedAt = new Date(this.now()).toISOString();
    this._commit({ type: "tenant", tenant: merged });
    this.buckets.delete(tenantId); // 限流配置变更后重建令牌桶
    return clone(merged);
  }

  getTenant(tenantId) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new DomainError("NOT_FOUND", `租户不存在: ${tenantId}`);
    return clone({
      ...tenant,
      wallets: this._walletView(tenantId),
      periods: [...this.periods.values()]
        .filter((p) => p.tenantId === tenantId)
        .map((p) => clone(p)),
    });
  }

  addRateCard(input) {
    const model = requireString(input.model, "model");
    const version = requireString(input.version, "version");
    const effectiveAtMs = parseInstant(input.effectiveAt, "effectiveAt");
    const currency = requireString(input.currency ?? "USD", "currency");
    const inputPerMillionMicro = toMicro(input.inputPerMillion ?? 0, "inputPerMillion");
    const outputPerMillionMicro = toMicro(input.outputPerMillion ?? 0, "outputPerMillion");
    const cards = this.rateCards.get(model) ?? [];
    if (cards.some((c) => c.version === version)) {
      throw new DomainError("CONFLICT", `模型 ${model} 的费率版本已存在: ${version}`);
    }
    if (cards.some((c) => c.effectiveAtMs === effectiveAtMs)) {
      throw new DomainError("CONFLICT", `模型 ${model} 在该生效时间已有费率版本`);
    }
    const card = {
      model,
      version,
      effectiveAt: new Date(effectiveAtMs).toISOString(),
      effectiveAtMs,
      currency,
      inputPerMillionMicro,
      outputPerMillionMicro,
    };
    this._commit({ type: "rate_card", card });
    return clone(card);
  }

  listRateCards(model) {
    if (model) return clone(this.rateCards.get(model) ?? []);
    return clone([...this.rateCards.values()].flat());
  }

  findRateCard(model, at) {
    return clone(this._findRate(model, parseInstant(at, "at")));
  }

  addFxRate(input) {
    const base = requireString(input.base, "base").toUpperCase();
    const quote = requireString(input.quote, "quote").toUpperCase();
    if (typeof input.rate !== "number" || !(input.rate > 0)) {
      throw new DomainError("VALIDATION", "字段 rate 必须是正数");
    }
    const effectiveAtMs = parseInstant(input.effectiveAt, "effectiveAt");
    const fx = {
      base,
      quote,
      rate: input.rate,
      effectiveAt: new Date(effectiveAtMs).toISOString(),
      effectiveAtMs,
    };
    this._commit({ type: "fx_rate", fx });
    return clone(fx);
  }

  createPlan(input) {
    const planId = requireString(input.planId, "planId");
    if (this.plans.has(planId)) {
      throw new DomainError("CONFLICT", `套餐已存在: ${planId}`);
    }
    const quotas = (input.quotas ?? []).map((q) => ({
      model: requireString(q.model, "quotas[].model"),
      tokens: requireTokenCount(q.tokens, "quotas[].tokens"),
    }));
    const plan = { planId, name: input.name ?? planId, quotas };
    this._commit({ type: "plan", plan });
    return clone(plan);
  }

  subscribe(tenantId, input) {
    const planId = requireString(input.planId, "planId");
    if (!this.plans.has(planId)) {
      throw new DomainError("NOT_FOUND", `套餐不存在: ${planId}`);
    }
    this._ensureTenant(tenantId);
    const subscription = {
      tenantId,
      planId,
      startedAt: new Date(this.now()).toISOString(),
    };
    this._commit({ type: "subscription", tenantId, subscription });
    return clone(subscription);
  }

  // ---------- 预付钱包 ----------

  topUp(input) {
    const tenantId = requireString(input.tenantId, "tenantId");
    const tenant = this._ensureTenant(tenantId);
    const currency = (input.currency ?? tenant.settlementCurrency).toUpperCase();
    const amountMicro = toMicro(input.amount, "amount");
    if (amountMicro === 0) throw new DomainError("VALIDATION", "充值金额必须大于 0");
    if (input.reference) {
      const existing = this.topupRefs.get(`${tenantId}:${input.reference}`);
      if (existing) {
        return clone(this.ledger.find((e) => e.id === existing));
      }
    }
    const record = {
      type: "topup",
      id: newId("top"),
      tenantId,
      currency,
      amountMicro,
      reference: input.reference ?? null,
      createdAt: new Date(this.now()).toISOString(),
    };
    this._commit(record);
    return clone(this.ledger.find((e) => e.id === record.id));
  }

  getWallet(tenantId) {
    if (!this.tenants.has(tenantId)) {
      throw new DomainError("NOT_FOUND", `租户不存在: ${tenantId}`);
    }
    return { tenantId, wallets: this._walletView(tenantId) };
  }

  // ---------- 计量事件摄入 ----------

  /**
   * 摄入单条计量事件。以 (tenantId, eventId) 幂等去重，可乱序、可重放。
   * 归属：租户 + 模型 + UTC 计量窗口 + 租户时区结算周期。
   * 若事件所属周期已关账，则路由到其后第一个未关账周期并保留 lateForPeriod 关联。
   */
  ingestEvent(input) {
    const event = this._validateEvent(input);
    const tenant = this._ensureTenant(event.tenantId);
    this._checkRateLimit(event.tenantId, tenant);

    const key = `${event.tenantId}:${event.eventId}`;
    if (this.events.has(key)) {
      return {
        status: "duplicate",
        eventId: event.eventId,
        evidence: clone(this.evidence.get(key)),
      };
    }

    const occurredAtMs = parseInstant(event.occurredAt, "occurredAt");
    const receivedAt = new Date(this.now()).toISOString();
    const windowStart = windowStartOf(occurredAtMs, this.windowMs);

    let periodId = periodIdFor(occurredAtMs, tenant.settlementTimezone);
    let lateForPeriod = null;
    while (this._isClosed(event.tenantId, periodId)) {
      lateForPeriod = periodId;
      periodId = nextPeriodId(periodId);
    }

    // 费率版本按事件发生时间生效，历史用量不受新版本影响
    const rate = this._findRate(event.model, occurredAtMs);
    const fxRate = this._findFx(rate.currency, tenant.settlementCurrency, occurredAtMs);

    // 套餐额度（词元数）先抵扣输入、再抵扣输出，剩余部分才计价
    const quotaRemaining = this._planQuotaRemaining(event.tenantId, periodId, event.model);
    const freeIn = Math.min(event.tokensIn, quotaRemaining);
    const freeOut = Math.min(event.tokensOut, quotaRemaining - freeIn);
    const billableIn = event.tokensIn - freeIn;
    const billableOut = event.tokensOut - freeOut;

    const costMicro =
      Math.round((billableIn * rate.inputPerMillionMicro) / MICRO) +
      Math.round((billableOut * rate.outputPerMillionMicro) / MICRO);
    const amountMicro = Math.round(costMicro * fxRate);

    // 预付额度扣减：余额不足部分转为后付欠费，钱包永不透支。
    // 整个计算-提交过程同步执行，并发请求在单线程下不会交错，余额不会为负。
    const currency = tenant.settlementCurrency;
    const balance = this._walletBalance(event.tenantId, currency);
    const prepaidMicro = Math.min(balance, amountMicro);
    const overageMicro = amountMicro - prepaidMicro;

    const chargeId = newId("chg");
    const evidencePayload = {
      eventId: event.eventId,
      tenantId: event.tenantId,
      model: event.model,
      occurredAt: event.occurredAt,
      receivedAt,
      windowStart,
      periodId,
      lateForPeriod,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      rateVersion: rate.version,
    };
    const evidenceRecord = {
      payload: evidencePayload,
      signature: signPayload(this.signingKey, evidencePayload),
    };

    const anomaly = this._detectAnomaly(
      event.tenantId,
      event.model,
      windowStart,
      event.tokensIn + event.tokensOut,
      tenant.anomaly,
      receivedAt,
    );

    const record = {
      type: "usage_event",
      event: { ...event, receivedAt },
      derived: {
        windowStart,
        periodId,
        lateForPeriod,
        rateVersion: rate.version,
        rateCurrency: rate.currency,
        fxRate,
        currency,
        freeIn,
        freeOut,
        billableIn,
        billableOut,
        planCoveredTokens: freeIn + freeOut,
        costMicro,
        amountMicro,
        prepaidMicro,
        overageMicro,
      },
      chargeId,
      evidence: evidenceRecord,
      anomaly,
    };
    this._commit(record);

    return {
      status: "accepted",
      eventId: event.eventId,
      windowStart,
      periodId,
      lateForPeriod,
      rateVersion: rate.version,
      charge: {
        id: chargeId,
        currency,
        amountMicro,
        prepaidMicro,
        overageMicro,
        planCoveredTokens: freeIn + freeOut,
      },
      evidence: clone(evidenceRecord),
      anomaly: anomaly ? clone(anomaly) : null,
    };
  }

  getUsageEvent(tenantId, eventId) {
    const key = `${tenantId}:${eventId}`;
    const event = this.events.get(key);
    if (!event) throw new DomainError("NOT_FOUND", `计量事件不存在: ${eventId}`);
    return clone(event);
  }

  getEvidence(tenantId, eventId) {
    const key = `${tenantId}:${eventId}`;
    const evidence = this.evidence.get(key);
    if (!evidence) throw new DomainError("NOT_FOUND", `计量证据不存在: ${eventId}`);
    return clone({
      ...evidence,
      valid: verifyPayload(this.signingKey, evidence.payload, evidence.signature),
    });
  }

  listWindows(tenantId, model) {
    return clone(
      [...this.windows.values()].filter(
        (w) => w.tenantId === tenantId && (model === undefined || w.model === model),
      ),
    );
  }

  // ---------- 关账与账单 ----------

  /**
   * 关闭结算周期并出账。账单行按 (模型, 费率版本) 聚合，逐项携带计量证据
   * 引用与聚合签名；迟到事件已在摄入时路由到本周期并保留原周期关联。
   */
  closePeriod(tenantId, periodId) {
    if (!this.tenants.has(tenantId)) {
      throw new DomainError("NOT_FOUND", `租户不存在: ${tenantId}`);
    }
    if (!/^\d{4}-\d{2}$/.test(periodId)) {
      throw new DomainError("VALIDATION", `非法结算周期: ${periodId}`);
    }
    if (this._isClosed(tenantId, periodId)) {
      throw new DomainError("CONFLICT", `结算周期已关账: ${periodId}`);
    }
    const tenant = this.tenants.get(tenantId);
    const charges = this.ledger.filter(
      (e) => e.type === "charge" && e.tenantId === tenantId && e.periodId === periodId,
    );
    const reversals = this.ledger.filter(
      (e) => e.type === "reversal" && e.tenantId === tenantId && e.periodId === periodId,
    );

    const groups = new Map();
    for (const charge of charges) {
      const gKey = `${charge.model}|${charge.rateVersion}|${charge.currency}`;
      if (!groups.has(gKey)) {
        groups.set(gKey, {
          model: charge.model,
          rateVersion: charge.rateVersion,
          currency: charge.currency,
          tokensIn: 0,
          tokensOut: 0,
          planCoveredTokens: 0,
          billableTokens: 0,
          amountMicro: 0,
          prepaidMicro: 0,
          overageMicro: 0,
          windows: new Set(),
          evidenceRefs: [],
          chargeIds: [],
          lateForPeriods: new Set(),
        });
      }
      const g = groups.get(gKey);
      g.tokensIn += charge.tokensIn;
      g.tokensOut += charge.tokensOut;
      g.planCoveredTokens += charge.planCoveredTokens;
      g.billableTokens += charge.billableIn + charge.billableOut;
      g.amountMicro += charge.amountMicro;
      g.prepaidMicro += charge.prepaidMicro;
      g.overageMicro += charge.overageMicro;
      g.windows.add(charge.windowStart);
      g.evidenceRefs.push(charge.eventId);
      g.chargeIds.push(charge.id);
      if (charge.lateForPeriod) g.lateForPeriods.add(charge.lateForPeriod);
    }

    const invoiceId = `INV-${tenantId}-${periodId}`;
    const lines = [...groups.values()].map((g, i) => {
      const signatures = g.evidenceRefs
        .map((eventId) => this.evidence.get(`${tenantId}:${eventId}`)?.signature)
        .filter(Boolean)
        .sort();
      const anomalies = [...g.windows]
        .map((w) => this.anomalies.get(this.anomalyIndex.get(`${tenantId}|${g.model}|${w}`)))
        .filter(Boolean)
        .map((a) => ({ id: a.id, windowStart: a.windowStart, status: a.status }));
      return {
        lineItemId: `${invoiceId}/L${i + 1}`,
        kind: "usage",
        model: g.model,
        rateVersion: g.rateVersion,
        currency: g.currency,
        tokensIn: g.tokensIn,
        tokensOut: g.tokensOut,
        planCoveredTokens: g.planCoveredTokens,
        billableTokens: g.billableTokens,
        amountMicro: g.amountMicro,
        prepaidMicro: g.prepaidMicro,
        overageMicro: g.overageMicro,
        windows: [...g.windows].sort((a, b) => a - b),
        evidenceRefs: [...g.evidenceRefs].sort(),
        evidenceSignature: signPayload(this.signingKey, {
          tenantId,
          periodId,
          model: g.model,
          rateVersion: g.rateVersion,
          signatures,
        }),
        chargeIds: g.chargeIds,
        lateForPeriods: [...g.lateForPeriods].sort(),
        anomalies,
      };
    });

    const reversalLines = reversals.map((r, i) => ({
      lineItemId: `${invoiceId}/R${i + 1}`,
      kind: "reversal",
      reversalOf: r.reversalOf,
      amountMicro: -r.amountMicro,
      prepaidMicro: -r.prepaidMicro,
      reason: r.reason,
      createdAt: r.createdAt,
    }));

    const chargeTotalMicro = lines.reduce((sum, l) => sum + l.amountMicro, 0);
    const reversalTotalMicro = reversalLines.reduce((sum, l) => sum + l.amountMicro, 0);
    const closedAt = new Date(this.now()).toISOString();
    const invoice = {
      id: invoiceId,
      tenantId,
      periodId,
      currency: tenant.settlementCurrency,
      status: "issued",
      lines: [...lines, ...reversalLines],
      chargeTotalMicro,
      reversalTotalMicro,
      totalMicro: chargeTotalMicro + reversalTotalMicro,
      createdAt: closedAt,
    };
    this._commit({ type: "period_closed", tenantId, periodId, closedAt, invoice });
    return clone(invoice);
  }

  getInvoice(invoiceId) {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new DomainError("NOT_FOUND", `账单不存在: ${invoiceId}`);
    return clone(invoice);
  }

  listInvoices(tenantId) {
    return clone(
      [...this.invoices.values()].filter((inv) => !tenantId || inv.tenantId === tenantId),
    );
  }

  /** 逐项核验账单：每条用量行的证据签名与聚合签名都可独立重算。 */
  verifyInvoice(invoiceId) {
    const invoice = this.getInvoice(invoiceId);
    const lines = invoice.lines
      .filter((l) => l.kind === "usage")
      .map((line) => {
        const evidenceItems = line.evidenceRefs.map((eventId) =>
          this.evidence.get(`${invoice.tenantId}:${eventId}`),
        );
        const evidenceValid = evidenceItems.every(
          (e) => e && verifyPayload(this.signingKey, e.payload, e.signature),
        );
        const signatures = evidenceItems.map((e) => e?.signature).filter(Boolean).sort();
        const expected = signPayload(this.signingKey, {
          tenantId: invoice.tenantId,
          periodId: invoice.periodId,
          model: line.model,
          rateVersion: line.rateVersion,
          signatures,
        });
        return {
          lineItemId: line.lineItemId,
          evidenceChecked: evidenceItems.length,
          valid: evidenceValid && expected === line.evidenceSignature,
        };
      });
    return {
      invoiceId,
      valid: lines.every((l) => l.valid),
      lines,
    };
  }

  // ---------- 争议冲正 ----------

  /**
   * 争议更正：只追加冲正分录，历史账目保持不变。
   * 可按 chargeId / eventId / lineItemId 定位；缺省冲销剩余全部金额。
   * 冲正中属于预付的部分即时退回钱包；冲正计入当前未关账周期。
   */
  dispute(input) {
    const tenantId = requireString(input.tenantId, "tenantId");
    const reason = requireString(input.reason ?? "dispute", "reason");
    const charges = this._resolveDisputeTargets(tenantId, input);
    if (charges.length === 0) {
      throw new DomainError("NOT_FOUND", "未找到可冲正的计费分录");
    }
    const periodId = this._currentOpenPeriod(tenantId);
    const createdAt = new Date(this.now()).toISOString();
    const disputeId = newId("dsp");
    const reversals = [];

    for (const charge of charges) {
      const reversed = this._reversedFor(charge.id);
      const remaining = charge.amountMicro - reversed.amountMicro;
      if (remaining <= 0) {
        throw new DomainError("CONFLICT", `分录 ${charge.id} 已被全额冲正`);
      }
      let amountMicro;
      if (charges.length === 1 && input.amount !== undefined) {
        amountMicro = toMicro(input.amount, "amount");
        if (amountMicro === 0 || amountMicro > remaining) {
          throw new DomainError(
            "VALIDATION",
            `冲正金额必须大于 0 且不超过剩余可冲金额 ${remaining}`,
          );
        }
      } else {
        amountMicro = remaining;
      }
      const prepaidMicro =
        amountMicro === remaining
          ? charge.prepaidMicro - reversed.prepaidMicro
          : Math.round((amountMicro * charge.prepaidMicro) / charge.amountMicro);
      const record = {
        type: "reversal",
        id: newId("rev"),
        disputeId,
        reversalOf: charge.id,
        tenantId,
        periodId,
        currency: charge.currency,
        amountMicro,
        prepaidMicro,
        reason,
        createdAt,
      };
      this._commit(record);
      reversals.push(clone(this.ledger[this.ledger.length - 1]));
    }
    return { disputeId, reversals };
  }

  // ---------- 异常峰值 ----------

  listAnomalies(filter = {}) {
    return clone(
      [...this.anomalies.values()].filter(
        (a) =>
          (!filter.tenantId || a.tenantId === filter.tenantId) &&
          (!filter.status || a.status === filter.status),
      ),
    );
  }

  /**
   * 处置异常峰值：confirmed 维持计费；waived 对该窗口全部计费分录做冲正。
   */
  resolveAnomaly(anomalyId, input) {
    const anomaly = this.anomalies.get(anomalyId);
    if (!anomaly) throw new DomainError("NOT_FOUND", `异常记录不存在: ${anomalyId}`);
    const status = requireString(input.status, "status");
    if (!["confirmed", "waived"].includes(status)) {
      throw new DomainError("VALIDATION", "status 必须是 confirmed 或 waived");
    }
    if (anomaly.status !== "flagged") {
      throw new DomainError("CONFLICT", `异常记录已处置: ${anomaly.status}`);
    }
    const updatedAt = new Date(this.now()).toISOString();
    this._commit({
      type: "anomaly_update",
      id: anomalyId,
      status,
      note: input.note ?? null,
      updatedAt,
    });

    const reversals = [];
    if (status === "waived") {
      const targets = this.ledger.filter(
        (e) =>
          e.type === "charge" &&
          e.tenantId === anomaly.tenantId &&
          e.model === anomaly.model &&
          e.windowStart === anomaly.windowStart,
      );
      for (const charge of targets) {
        const reversed = this._reversedFor(charge.id);
        const remaining = charge.amountMicro - reversed.amountMicro;
        if (remaining <= 0) continue;
        const record = {
          type: "reversal",
          id: newId("rev"),
          disputeId: null,
          anomalyId,
          reversalOf: charge.id,
          tenantId: anomaly.tenantId,
          periodId: this._currentOpenPeriod(anomaly.tenantId),
          currency: charge.currency,
          amountMicro: remaining,
          prepaidMicro: charge.prepaidMicro - reversed.prepaidMicro,
          reason: `anomaly-waived:${anomalyId}`,
          createdAt: new Date(this.now()).toISOString(),
        };
        this._commit(record);
        reversals.push(clone(this.ledger[this.ledger.length - 1]));
      }
    }
    return { anomaly: clone(this.anomalies.get(anomalyId)), reversals };
  }

  listLedger(tenantId, periodId) {
    return clone(
      this.ledger.filter(
        (e) =>
          (!tenantId || e.tenantId === tenantId) && (!periodId || e.periodId === periodId),
      ),
    );
  }

  // ---------- 内部：校验与派生 ----------

  _validateEvent(input) {
    return {
      eventId: requireString(input.eventId, "eventId"),
      tenantId: requireString(input.tenantId, "tenantId"),
      model: requireString(input.model, "model"),
      occurredAt: requireString(input.occurredAt, "occurredAt"),
      tokensIn: requireTokenCount(input.tokensIn, "tokensIn"),
      tokensOut: requireTokenCount(input.tokensOut, "tokensOut"),
    };
  }

  _ensureTenant(tenantId) {
    let tenant = this.tenants.get(tenantId);
    if (!tenant) {
      tenant = {
        id: tenantId,
        ...clone(DEFAULT_PROFILE),
        createdAt: new Date(this.now()).toISOString(),
      };
      this._commit({ type: "tenant", tenant });
    }
    return tenant;
  }

  _checkRateLimit(tenantId, tenant) {
    let bucket = this.buckets.get(tenantId);
    if (!bucket) {
      bucket = new TokenBucket(tenant.rateLimit.capacity, tenant.rateLimit.refillPerSec);
      this.buckets.set(tenantId, bucket);
    }
    const result = bucket.tryTake(this.now());
    if (!result.ok) {
      throw new DomainError("RATE_LIMITED", `租户 ${tenantId} 触发突发限流`, {
        retryAfterSec: result.retryAfterSec,
      });
    }
  }

  _findRate(model, atMs) {
    const cards = this.rateCards.get(model);
    if (!cards || cards.length === 0) {
      throw new DomainError("NO_RATE", `模型 ${model} 没有费率`);
    }
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      if (cards[i].effectiveAtMs <= atMs) return cards[i];
    }
    throw new DomainError(
      "NO_RATE",
      `模型 ${model} 在 ${new Date(atMs).toISOString()} 前无生效费率`,
    );
  }

  _findFx(base, quote, atMs) {
    if (base === quote) return 1;
    const list = this.fxRates.get(`${base}:${quote}`);
    if (!list) {
      throw new DomainError("NO_FX", `缺少汇率 ${base}->${quote}`);
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].effectiveAtMs <= atMs) return list[i].rate;
    }
    throw new DomainError("NO_FX", `汇率 ${base}->${quote} 在该时间前未生效`);
  }

  _planQuotaRemaining(tenantId, periodId, model) {
    const subscription = this.subscriptions.get(tenantId);
    if (!subscription) return 0;
    const plan = this.plans.get(subscription.planId);
    const quota = plan?.quotas.find((q) => q.model === model);
    if (!quota) return 0;
    const used = this.planUsage.get(`${tenantId}|${periodId}|${model}`) ?? 0;
    return Math.max(0, quota.tokens - used);
  }

  _isClosed(tenantId, periodId) {
    return this.periods.get(`${tenantId}|${periodId}`)?.status === "closed";
  }

  _currentOpenPeriod(tenantId) {
    const tenant = this.tenants.get(tenantId);
    let periodId = periodIdFor(this.now(), tenant?.settlementTimezone ?? "UTC");
    while (this._isClosed(tenantId, periodId)) {
      periodId = nextPeriodId(periodId);
    }
    return periodId;
  }

  _walletBalance(tenantId, currency) {
    return this.wallets.get(tenantId)?.get(currency) ?? 0;
  }

  _walletView(tenantId) {
    const wallet = this.wallets.get(tenantId);
    if (!wallet) return [];
    return [...wallet.entries()].map(([currency, balanceMicro]) => ({
      currency,
      balanceMicro,
    }));
  }

  _reversedFor(chargeId) {
    let amountMicro = 0;
    let prepaidMicro = 0;
    for (const entry of this.ledger) {
      if (entry.type === "reversal" && entry.reversalOf === chargeId) {
        amountMicro += entry.amountMicro;
        prepaidMicro += entry.prepaidMicro;
      }
    }
    return { amountMicro, prepaidMicro };
  }

  _resolveDisputeTargets(tenantId, input) {
    if (input.chargeId) {
      const charge = this.ledger.find((e) => e.type === "charge" && e.id === input.chargeId);
      return charge && charge.tenantId === tenantId ? [charge] : [];
    }
    if (input.eventId) {
      const charge = this.ledger.find(
        (e) => e.type === "charge" && e.tenantId === tenantId && e.eventId === input.eventId,
      );
      return charge ? [charge] : [];
    }
    if (input.lineItemId) {
      const invoice = [...this.invoices.values()].find((inv) =>
        inv.lines.some((l) => l.lineItemId === input.lineItemId),
      );
      const line = invoice?.lines.find((l) => l.lineItemId === input.lineItemId);
      if (!line || line.kind !== "usage") return [];
      return line.chargeIds
        .map((id) => this.ledger.find((e) => e.type === "charge" && e.id === id))
        .filter(Boolean);
    }
    throw new DomainError("VALIDATION", "必须提供 chargeId、eventId 或 lineItemId 之一");
  }

  _detectAnomaly(tenantId, model, windowStart, addedTokens, cfg, at) {
    const indexKey = `${tenantId}|${model}|${windowStart}`;
    const existingId = this.anomalyIndex.get(indexKey);
    const current = this.windows.get(indexKey);
    const projected = (current ? current.tokensIn + current.tokensOut : 0) + addedTokens;
    if (existingId) {
      const existing = this.anomalies.get(existingId);
      return { ...existing, observed: projected, updatedAt: at };
    }
    const baseline = [...this.windows.values()]
      .filter((w) => w.tenantId === tenantId && w.model === model && w.windowStart < windowStart)
      .sort((a, b) => b.windowStart - a.windowStart)
      .slice(0, cfg.baselineWindows)
      .map((w) => w.tokensIn + w.tokensOut);
    if (baseline.length < cfg.minBaseline) return null;
    const baselineMedian = median(baseline);
    const threshold = Math.max(cfg.floorTokens, cfg.multiplier * baselineMedian);
    if (projected <= threshold) return null;
    return {
      id: newId("ano"),
      tenantId,
      model,
      windowStart,
      observed: projected,
      baselineMedian,
      threshold,
      status: "flagged",
      createdAt: at,
      updatedAt: at,
    };
  }

  // ---------- 内部：日志提交与重放 ----------

  _commit(record) {
    this.journal.append(record);
    this._apply(record);
  }

  _apply(record) {
    switch (record.type) {
      case "tenant": {
        this.tenants.set(record.tenant.id, record.tenant);
        break;
      }
      case "rate_card": {
        const cards = this.rateCards.get(record.card.model) ?? [];
        cards.push(record.card);
        cards.sort((a, b) => a.effectiveAtMs - b.effectiveAtMs);
        this.rateCards.set(record.card.model, cards);
        break;
      }
      case "fx_rate": {
        const key = `${record.fx.base}:${record.fx.quote}`;
        const list = this.fxRates.get(key) ?? [];
        list.push(record.fx);
        list.sort((a, b) => a.effectiveAtMs - b.effectiveAtMs);
        this.fxRates.set(key, list);
        break;
      }
      case "plan": {
        this.plans.set(record.plan.planId, record.plan);
        break;
      }
      case "subscription": {
        this.subscriptions.set(record.tenantId, record.subscription);
        break;
      }
      case "topup": {
        this._creditWallet(record.tenantId, record.currency, record.amountMicro);
        if (record.reference) {
          this.topupRefs.set(`${record.tenantId}:${record.reference}`, record.id);
        }
        this.ledger.push({
          seq: this.ledger.length,
          id: record.id,
          type: "topup",
          tenantId: record.tenantId,
          currency: record.currency,
          amountMicro: record.amountMicro,
          reference: record.reference,
          createdAt: record.createdAt,
        });
        break;
      }
      case "usage_event": {
        const { event, derived, chargeId, evidence, anomaly } = record;
        const key = `${event.tenantId}:${event.eventId}`;
        this.events.set(key, { ...event, ...derived, chargeId });

        const wKey = `${event.tenantId}|${event.model}|${derived.windowStart}`;
        const windowAgg = this.windows.get(wKey) ?? {
          tenantId: event.tenantId,
          model: event.model,
          windowStart: derived.windowStart,
          tokensIn: 0,
          tokensOut: 0,
          eventIds: [],
        };
        windowAgg.tokensIn += event.tokensIn;
        windowAgg.tokensOut += event.tokensOut;
        windowAgg.eventIds.push(event.eventId);
        this.windows.set(wKey, windowAgg);

        if (derived.planCoveredTokens > 0) {
          const pKey = `${event.tenantId}|${derived.periodId}|${event.model}`;
          this.planUsage.set(
            pKey,
            (this.planUsage.get(pKey) ?? 0) + derived.planCoveredTokens,
          );
        }
        if (derived.prepaidMicro > 0) {
          this._creditWallet(event.tenantId, derived.currency, -derived.prepaidMicro);
        }
        this.evidence.set(key, evidence);
        this.ledger.push({
          seq: this.ledger.length,
          id: chargeId,
          type: "charge",
          tenantId: event.tenantId,
          periodId: derived.periodId,
          lateForPeriod: derived.lateForPeriod,
          eventId: event.eventId,
          model: event.model,
          windowStart: derived.windowStart,
          rateVersion: derived.rateVersion,
          rateCurrency: derived.rateCurrency,
          fxRate: derived.fxRate,
          currency: derived.currency,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          billableIn: derived.billableIn,
          billableOut: derived.billableOut,
          planCoveredTokens: derived.planCoveredTokens,
          costMicro: derived.costMicro,
          amountMicro: derived.amountMicro,
          prepaidMicro: derived.prepaidMicro,
          overageMicro: derived.overageMicro,
          createdAt: event.receivedAt,
        });
        if (anomaly) {
          this.anomalies.set(anomaly.id, anomaly);
          this.anomalyIndex.set(
            `${anomaly.tenantId}|${anomaly.model}|${anomaly.windowStart}`,
            anomaly.id,
          );
        }
        break;
      }
      case "period_closed": {
        this.periods.set(`${record.tenantId}|${record.periodId}`, {
          tenantId: record.tenantId,
          periodId: record.periodId,
          status: "closed",
          closedAt: record.closedAt,
          invoiceId: record.invoice.id,
        });
        this.invoices.set(record.invoice.id, record.invoice);
        break;
      }
      case "reversal": {
        if (record.prepaidMicro > 0) {
          this._creditWallet(record.tenantId, record.currency, record.prepaidMicro);
        }
        this.ledger.push({
          seq: this.ledger.length,
          id: record.id,
          type: "reversal",
          tenantId: record.tenantId,
          periodId: record.periodId,
          reversalOf: record.reversalOf,
          disputeId: record.disputeId ?? null,
          anomalyId: record.anomalyId ?? null,
          currency: record.currency,
          amountMicro: record.amountMicro,
          prepaidMicro: record.prepaidMicro,
          reason: record.reason,
          createdAt: record.createdAt,
        });
        break;
      }
      case "anomaly_update": {
        const anomaly = this.anomalies.get(record.id);
        if (anomaly) {
          this.anomalies.set(record.id, {
            ...anomaly,
            status: record.status,
            note: record.note,
            updatedAt: record.updatedAt,
          });
        }
        break;
      }
      default:
        throw new Error(`未知日志记录类型: ${record.type}`);
    }
  }

  _creditWallet(tenantId, currency, deltaMicro) {
    if (!this.wallets.has(tenantId)) this.wallets.set(tenantId, new Map());
    const wallet = this.wallets.get(tenantId);
    wallet.set(currency, (wallet.get(currency) ?? 0) + deltaMicro);
  }
}
