import assert from "node:assert/strict";
import test from "node:test";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

test("关账出账后，迟到事件进入下一结算周期并保留关联", () => {
  const service = makeService();
  withRateCard(service);
  service.ingestEvent(usageEvent({ eventId: "j1", occurredAt: "2026-01-10T00:00:00Z" }));

  const invoice = service.closePeriod("t1", "2026-01");
  assert.equal(invoice.id, "INV-t1-2026-01");
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.lines.length, 1);

  // 关账后到达的 1 月事件：计入 2 月周期，但保留原周期关联
  const late = service.ingestEvent(usageEvent({ eventId: "j2", occurredAt: "2026-01-20T00:00:00Z" }));
  assert.equal(late.status, "accepted");
  assert.equal(late.periodId, "2026-02");
  assert.equal(late.lateForPeriod, "2026-01");

  const febInvoice = service.closePeriod("t1", "2026-02");
  const lateLine = febInvoice.lines.find((l) => l.kind === "usage");
  assert.deepEqual(lateLine.lateForPeriods, ["2026-01"]);
});

test("重复关账被拒绝", () => {
  const service = makeService();
  withRateCard(service);
  service.ingestEvent(usageEvent());
  service.closePeriod("t1", "2026-01");
  assert.throws(() => service.closePeriod("t1", "2026-01"), /已关账/);
});

test("关账后的争议冲正计入当前未关账周期", () => {
  const service = makeService({ now: () => Date.parse("2026-02-05T00:00:00Z") });
  withRateCard(service);
  service.ingestEvent(usageEvent({ eventId: "d1", occurredAt: "2026-01-10T00:00:00Z" }));
  service.closePeriod("t1", "2026-01");

  const { reversals } = service.dispute({ tenantId: "t1", eventId: "d1", reason: "计量异议" });
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].periodId, "2026-02"); // 1 月已关账，冲正落到 2 月

  const febInvoice = service.closePeriod("t1", "2026-02");
  const reversalLine = febInvoice.lines.find((l) => l.kind === "reversal");
  assert.ok(reversalLine);
  assert.equal(reversalLine.amountMicro, -reversals[0].amountMicro);
});
