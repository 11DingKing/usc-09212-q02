import assert from "node:assert/strict";
import test from "node:test";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

test("争议通过冲正更正，历史分录不被改写", () => {
  const service = makeService();
  withRateCard(service);
  service.topUp({ tenantId: "t1", amount: 1, currency: "USD" });
  service.ingestEvent(usageEvent({ eventId: "x1", tokensIn: 1000, tokensOut: 0 }));

  const before = service.listLedger("t1").find((e) => e.type === "charge");
  assert.equal(before.amountMicro, 1000);
  assert.equal(before.prepaidMicro, 1000);
  const balanceBefore = service.getWallet("t1").wallets[0].balanceMicro;
  assert.equal(balanceBefore, 1_000_000 - 1000);

  const { reversals } = service.dispute({ tenantId: "t1", eventId: "x1", reason: "重复计量" });
  assert.equal(reversals[0].amountMicro, 1000);
  assert.equal(reversals[0].reversalOf, before.id);

  // 历史分录保持原值，冲正是新增分录
  const after = service.listLedger("t1").find((e) => e.id === before.id);
  assert.deepEqual(after, before);
  const entries = service.listLedger("t1");
  assert.deepEqual(
    entries.map((e) => e.type).sort(),
    ["charge", "reversal", "topup"],
  );

  // 预付部分退回钱包
  const balanceAfter = service.getWallet("t1").wallets[0].balanceMicro;
  assert.equal(balanceAfter, 1_000_000);
});

test("部分冲正与超额冲正校验", () => {
  const service = makeService();
  withRateCard(service);
  service.ingestEvent(usageEvent({ eventId: "x2", tokensIn: 1000, tokensOut: 0 }));

  const { reversals } = service.dispute({
    tenantId: "t1",
    eventId: "x2",
    amount: 0.0004, // 400 micro
    reason: "部分异议",
  });
  assert.equal(reversals[0].amountMicro, 400);

  assert.throws(
    () => service.dispute({ tenantId: "t1", eventId: "x2", amount: 0.001, reason: "超额" }),
    /不超过剩余可冲金额/,
  );

  service.dispute({ tenantId: "t1", eventId: "x2", reason: "剩余全部" });
  assert.throws(
    () => service.dispute({ tenantId: "t1", eventId: "x2", reason: "再次" }),
    /已被全额冲正/,
  );
});

test("可按账单行项目冲正", () => {
  const service = makeService();
  withRateCard(service);
  service.ingestEvent(usageEvent({ eventId: "x3", tokensIn: 1000, tokensOut: 0 }));
  service.ingestEvent(usageEvent({ eventId: "x4", tokensIn: 2000, tokensOut: 0 }));
  const invoice = service.closePeriod("t1", "2026-01");
  const line = invoice.lines.find((l) => l.kind === "usage");

  const { reversals } = service.dispute({
    tenantId: "t1",
    lineItemId: line.lineItemId,
    reason: "整行异议",
  });
  assert.equal(reversals.length, 2);
  assert.equal(
    reversals.reduce((s, r) => s + r.amountMicro, 0),
    line.amountMicro,
  );
});
