import assert from "node:assert/strict";
import test from "node:test";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

const ANOMALY_CFG = { multiplier: 3, floorTokens: 100, baselineWindows: 10, minBaseline: 3 };

function feedBaseline(service, tenantId) {
  for (let i = 0; i < 3; i += 1) {
    service.ingestEvent(
      usageEvent({
        eventId: `${tenantId}-b${i}`,
        tenantId,
        occurredAt: `2026-01-10T00:0${i}:10Z`,
        tokensIn: 100,
        tokensOut: 0,
      }),
    );
  }
}

test("异常峰值被标记并携带处理状态", () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-a", { anomaly: ANOMALY_CFG });
  feedBaseline(service, "t-a");

  const spike = service.ingestEvent(
    usageEvent({ eventId: "spike", tenantId: "t-a", occurredAt: "2026-01-10T00:03:10Z", tokensIn: 5000, tokensOut: 0 }),
  );
  assert.ok(spike.anomaly);
  assert.equal(spike.anomaly.status, "flagged");
  assert.equal(spike.anomaly.observed, 5000);

  const anomalies = service.listAnomalies({ tenantId: "t-a", status: "flagged" });
  assert.equal(anomalies.length, 1);

  const { anomaly, reversals } = service.resolveAnomaly(anomalies[0].id, { status: "confirmed" });
  assert.equal(anomaly.status, "confirmed");
  assert.equal(reversals.length, 0);
  assert.throws(
    () => service.resolveAnomaly(anomalies[0].id, { status: "waived" }),
    /已处置/,
  );
});

test("豁免异常峰值会对该窗口计费做冲正并退回预付", () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-w", { anomaly: ANOMALY_CFG });
  service.topUp({ tenantId: "t-w", amount: 1, currency: "USD" });
  feedBaseline(service, "t-w");

  const spike = service.ingestEvent(
    usageEvent({ eventId: "spike-w", tenantId: "t-w", occurredAt: "2026-01-10T00:03:10Z", tokensIn: 5000, tokensOut: 0 }),
  );
  const balanceBefore = service.getWallet("t-w").wallets[0].balanceMicro;

  const { anomaly, reversals } = service.resolveAnomaly(spike.anomaly.id, { status: "waived" });
  assert.equal(anomaly.status, "waived");
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].amountMicro, 5000);
  assert.match(reversals[0].reason, /anomaly-waived/);

  const balanceAfter = service.getWallet("t-w").wallets[0].balanceMicro;
  assert.equal(balanceAfter, balanceBefore + 5000);
});

test("正常波动不触发异常", () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-n", { anomaly: ANOMALY_CFG });
  feedBaseline(service, "t-n");
  const normal = service.ingestEvent(
    usageEvent({ eventId: "normal", tenantId: "t-n", occurredAt: "2026-01-10T00:03:10Z", tokensIn: 150, tokensOut: 0 }),
  );
  assert.equal(normal.anomaly, null);
});
