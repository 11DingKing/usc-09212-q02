import assert from "node:assert/strict";
import test from "node:test";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

test("重放同一计量事件被去重，只计费一次", () => {
  const service = makeService();
  withRateCard(service);

  const first = service.ingestEvent(usageEvent());
  assert.equal(first.status, "accepted");

  const replay = service.ingestEvent(usageEvent());
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.evidence.signature, first.evidence.signature);

  const charges = service.listLedger("t1").filter((e) => e.type === "charge");
  assert.equal(charges.length, 1);
  const windows = service.listWindows("t1", "gpt-x");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].tokensIn, 1000);
  assert.equal(windows[0].eventIds.length, 1);
});

test("乱序事件按事件时间归属到正确的租户/模型/时间窗", () => {
  const service = makeService();
  withRateCard(service);

  service.ingestEvent(usageEvent({ eventId: "e1", occurredAt: "2026-01-15T00:00:10Z" }));
  service.ingestEvent(usageEvent({ eventId: "e2", occurredAt: "2026-01-15T00:02:30Z" }));
  // 迟到乱序：窗口起点早于已摄入事件，仍归入其事件时间所在窗口
  service.ingestEvent(usageEvent({ eventId: "e3", occurredAt: "2026-01-15T00:00:05Z" }));

  const windows = service.listWindows("t1", "gpt-x").sort((a, b) => a.windowStart - b.windowStart);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].eventIds.sort(), ["e1", "e3"]);
  assert.equal(windows[0].tokensIn, 2000);
  assert.deepEqual(windows[1].eventIds, ["e2"]);
});

test("跨时区归属：同一时刻按租户时区进入不同结算周期", () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-sgt", { settlementTimezone: "Asia/Singapore" });

  // 2026-01-31T16:30Z = 新加坡时间 2026-02-01 00:30
  const occurredAt = "2026-01-31T16:30:00Z";
  const sgt = service.ingestEvent(usageEvent({ eventId: "sg1", tenantId: "t-sgt", occurredAt }));
  assert.equal(sgt.periodId, "2026-02");

  const utc = service.ingestEvent(usageEvent({ eventId: "u1", tenantId: "t-utc", occurredAt }));
  assert.equal(utc.periodId, "2026-01");
});

test("非法事件被拒绝且不影响状态", () => {
  const service = makeService();
  withRateCard(service);
  assert.throws(
    () => service.ingestEvent(usageEvent({ tokensIn: -1 })),
    /tokensIn/,
  );
  assert.throws(
    () => service.ingestEvent(usageEvent({ occurredAt: "not-a-time" })),
    /occurredAt/,
  );
  assert.equal(service.listLedger("t1").length, 0);
});
