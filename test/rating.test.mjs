import assert from "node:assert/strict";
import test from "node:test";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

test("费率版本只影响生效后的用量", () => {
  const service = makeService();
  withRateCard(service); // v1: 2026-01-01 起，输入 1 / 输出 2 USD 每百万词元
  service.addRateCard({
    model: "gpt-x",
    version: "v2",
    effectiveAt: "2026-02-01T00:00:00Z",
    inputPerMillion: 2,
    outputPerMillion: 4,
    currency: "USD",
  });

  const before = service.ingestEvent(
    usageEvent({ eventId: "r1", occurredAt: "2026-01-31T23:00:00Z", tokensIn: 1000, tokensOut: 1000 }),
  );
  assert.equal(before.rateVersion, "v1");
  assert.equal(before.charge.amountMicro, 1000 + 2000); // 1000*1 + 1000*2

  const after = service.ingestEvent(
    usageEvent({ eventId: "r2", occurredAt: "2026-02-02T00:00:00Z", tokensIn: 1000, tokensOut: 1000 }),
  );
  assert.equal(after.rateVersion, "v2");
  assert.equal(after.charge.amountMicro, 2000 + 4000);
});

test("费率生效前的事件被拒绝", () => {
  const service = makeService();
  withRateCard(service);
  assert.throws(
    () => service.ingestEvent(usageEvent({ occurredAt: "2025-12-31T23:59:59Z" })),
    /无生效费率|没有费率/,
  );
});

test("多币种：按事件时间汇率折算为租户结算币种", () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-sgd", { settlementCurrency: "SGD" });
  service.addFxRate({ base: "USD", quote: "SGD", rate: 1.35, effectiveAt: "2026-01-01T00:00:00Z" });

  const result = service.ingestEvent(
    usageEvent({ eventId: "f1", tenantId: "t-sgd", tokensIn: 1000, tokensOut: 0 }),
  );
  assert.equal(result.charge.currency, "SGD");
  assert.equal(result.charge.amountMicro, 1350); // 1000 micro USD * 1.35

  const charge = service.listLedger("t-sgd").find((e) => e.type === "charge");
  assert.equal(charge.rateCurrency, "USD");
  assert.equal(charge.fxRate, 1.35);
});

test("缺少汇率时拒绝计价", () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-myr", { settlementCurrency: "MYR" });
  assert.throws(
    () => service.ingestEvent(usageEvent({ tenantId: "t-myr" })),
    /缺少汇率/,
  );
});
