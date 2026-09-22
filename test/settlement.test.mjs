import assert from "node:assert/strict";
import test from "node:test";
import { SettlementService } from "../src/service.mjs";
import { makeEvent, fakeClock } from "./helpers.mjs";

const T0 = Date.parse("2026-10-05T08:00:00Z"); // 时钟已进入 10 月：9 月可关账，10 月不可

function setup(clockStart = T0) {
  const clock = fakeClock(clockStart);
  const service = SettlementService.open({ now: () => clock.now });
  service.registerTenant({ tenantId: "t1", currency: "USD", signingKey: "secret-key-1" });
  service.publishRate({ rateId: "r1", model: "gpt-a", currency: "USD", microsPerThousand: 1000, effectiveFrom: "2026-01-01T00:00:00Z" });
  service.grantCredit("t1", { amountMicros: 10_000_000 });
  return { service, clock };
}

test("关账出具账单并可逐项追溯签名证据、重算摘要", async () => {
  const { service } = setup();
  const e1 = makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: Date.parse("2026-09-02T10:00:00Z"), eventId: "e1", quantity: 1000 });
  const e2 = makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: Date.parse("2026-09-20T10:00:00Z"), eventId: "e2", quantity: 2000 });
  await service.ingest(e1);
  await service.ingest(e2);

  const closed = await service.closePeriod("2026-09");
  assert.equal(closed.status, "closed");
  const invoiceId = closed.invoices[0].invoiceId;
  assert.equal(closed.invoices[0].totalMicros, 3000);

  const evidence = service.invoiceEvidence(invoiceId);
  assert.equal(evidence.lines[0].events.length, 2);
  assert.equal(evidence.lines[0].events.find((e) => e.eventId === "e1").signature, e1.signature);

  assert.equal(service.verifyInvoice(invoiceId).valid, true);
});

test("周期未结束不可关账，已关账周期不可重复关账", async () => {
  const { service } = setup();
  assert.equal((await service.closePeriod("2026-10")).status, "period_not_ended");
  await service.closePeriod("2026-09");
  const again = await service.closePeriod("2026-09");
  assert.equal(again.results[0].alreadyClosed, true);
});

test("关账后迟到事件进入下一周期并保留原周期关联", async () => {
  const { service, clock } = setup();
  await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: Date.parse("2026-09-20T10:00:00Z"), eventId: "on-time", quantity: 1000 }));
  await service.closePeriod("2026-09");

  const late = await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: Date.parse("2026-09-25T10:00:00Z"), eventId: "late-1", quantity: 1000 }));
  assert.equal(late.status, "accepted");
  assert.equal(late.period, "2026-10");
  assert.equal(late.late, true);

  const october = service.usageOf("t1", "2026-10");
  assert.equal(october.models[0].quantity, 1000);
  // 9 月已关账的用量与账单保持不变
  const september = service.usageOf("t1", "2026-09");
  assert.equal(september.models[0].quantity, 1000);

  // 10 月账单行标注迟到事件数与原周期
  clock.now = Date.parse("2026-11-02T00:00:00Z");
  await service.closePeriod("2026-10");
  const octInvoice = service.invoicesOf("t1").invoices.find((inv) => inv.period === "2026-10");
  assert.equal(octInvoice.lines[0].lateUsageCount, 1);
  const evidence = service.invoiceEvidence(octInvoice.invoiceId);
  assert.equal(evidence.lines[0].events[0].originalPeriod, "2026-09");
});

test("争议通过冲正更正，原始条目与已出账单不变", async () => {
  const { service } = setup();
  await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: Date.parse("2026-09-15T10:00:00Z"), eventId: "disp-1", quantity: 1000 }));
  await service.closePeriod("2026-09");
  const before = service.balanceOf("t1").balanceMicros;
  const invoice = service.invoicesOf("t1").invoices.find((inv) => inv.period === "2026-09");
  const totalBefore = invoice.totalMicros;

  // 直接按账本扣款条目冲正
  const debit = service.ledgerOf("t1").entries.find((e) => e.type === "debit");
  const corrected = await service.openDispute({ tenantId: "t1", entryId: debit.entryId, reason: "客户申诉重复计量" });
  assert.equal(corrected.status, "corrected");
  assert.equal(service.balanceOf("t1").balanceMicros, before + 1000);

  // 重复冲正被拒；原始账单总额不动，冲正体现在账本与争议记录
  assert.equal((await service.openDispute({ tenantId: "t1", entryId: debit.entryId })).status, "already_reversed");
  assert.equal(service.invoicesOf("t1").invoices.find((inv) => inv.period === "2026-09").totalMicros, totalBefore);
  assert.equal(service.disputesOf("t1").disputes.length, 1);
});
