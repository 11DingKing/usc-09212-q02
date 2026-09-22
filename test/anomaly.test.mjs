import assert from "node:assert/strict";
import test from "node:test";
import { SettlementService } from "../src/service.mjs";
import { makeEvent, fakeClock } from "./helpers.mjs";

const T0 = Date.parse("2026-09-10T08:00:00Z");
const WINDOW_MS = 300_000;

function setup() {
  const clock = fakeClock(T0);
  const service = SettlementService.open({
    now: () => clock.now,
    windowMs: WINDOW_MS,
    anomaly: { minWindows: 3, multiplier: 5, absoluteFloorQuantity: 1000, historySize: 8 },
  });
  service.registerTenant({ tenantId: "t1", currency: "USD", signingKey: "secret-key-1" });
  service.publishRate({ rateId: "r1", model: "gpt-a", currency: "USD", microsPerThousand: 1000, effectiveFrom: "2026-01-01T00:00:00Z" });
  service.grantCredit("t1", { amountMicros: 100_000_000 });
  return { service, clock };
}

test("异常峰值开立待处理状态，拒绝后逐笔冲正", async () => {
  const { service } = setup();

  // 基线：连续 3 个窗口各 100 词元
  for (let i = 0; i < 3; i += 1) {
    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0 + i * WINDOW_MS, eventId: `base-${i}`, quantity: 100 }));
  }
  assert.equal(service.listAnomalies().anomalies.length, 0);

  // 突增窗口：1500 词元，超过阈值 max(1000, 100*5)
  await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0 + 3 * WINDOW_MS, eventId: "spike-1", quantity: 1500 }));
  const anomalies = service.listAnomalies().anomalies;
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].status, "pending_review");
  assert.equal(anomalies[0].observedQuantity, 1500);

  const balanceBefore = service.balanceOf("t1").balanceMicros;
  const review = service.reviewAnomaly(anomalies[0].anomalyId, { decision: "rejected", reviewer: "ops-lead" });
  assert.equal(review.status, "reviewed");
  assert.equal(review.reversalEntryIds.length, 1);
  assert.equal(service.balanceOf("t1").balanceMicros, balanceBefore + 1500);

  // 状态机不可重复复核
  const again = service.reviewAnomaly(anomalies[0].anomalyId, { decision: "approved" });
  assert.equal(again.status, "already_reviewed");

  // 原始扣款保留，冲正条目可追溯
  const entries = service.ledgerOf("t1").entries;
  const reversal = entries.find((e) => e.type === "reversal");
  assert.ok(reversal.reversesEntryId);
  assert.equal(entries.filter((e) => e.type === "debit").length, 4);
});

test("异常确认为合理峰值时维持计费", async () => {
  const { service } = setup();
  for (let i = 0; i < 3; i += 1) {
    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0 + i * WINDOW_MS, eventId: `b${i}`, quantity: 100 }));
  }
  await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0 + 3 * WINDOW_MS, eventId: "spike", quantity: 1500 }));
  const anomaly = service.listAnomalies().anomalies[0];
  const balance = service.balanceOf("t1").balanceMicros;
  service.reviewAnomaly(anomaly.anomalyId, { decision: "approved" });
  assert.equal(service.balanceOf("t1").balanceMicros, balance);
  assert.equal(service.listAnomalies({ status: "approved" }).anomalies.length, 1);
});
