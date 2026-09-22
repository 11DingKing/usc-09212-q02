import assert from "node:assert/strict";
import test from "node:test";
import { SettlementService } from "../src/service.mjs";
import { makeEvent, fakeClock } from "./helpers.mjs";

const T0 = Date.parse("2026-09-10T08:00:00+07:00"); // 曼谷时间，归一化后为 01:00Z

function setup(overrides = {}) {
  const clock = fakeClock(T0);
  const service = SettlementService.open({ now: () => clock.now, ...overrides });
  service.registerPlan({ code: "pro", tokensPerPeriod: 500 });
  service.registerTenant({
    tenantId: "t-bkk",
    currency: "THB",
    timezone: "Asia/Bangkok",
    signingKey: "secret-key-1",
    planCode: "pro",
  });
  service.publishRate({ rateId: "r1", model: "gpt-a", currency: "THB", microsPerThousand: 2000, effectiveFrom: "2026-01-01T00:00:00Z" });
  return { service, clock };
}

test("乱序与重放事件按去重键幂等入账", async () => {
  const { service } = setup();
  const later = makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: T0 + 60_000, eventId: "e2", quantity: 100 });
  const earlier = makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: T0, eventId: "e1", quantity: 100 });

  assert.equal((await service.ingest(later)).status, "accepted");
  assert.equal((await service.ingest(earlier)).status, "accepted"); // 乱序仍按事件时间入账
  const replay = await service.ingest(earlier); // 重放
  assert.equal(replay.status, "duplicate");

  const usage = service.usageOf("t-bkk", "2026-09");
  assert.equal(usage.models[0].quantity, 200); // 只入账一次
});

test("签名错误与未知租户被拒绝", async () => {
  const { service } = setup();
  const bad = makeEvent({ tenantId: "t-bkk", signingKey: "wrong-key-1" }, { at: T0 });
  assert.equal((await service.ingest(bad)).status, "invalid_signature");
  const stranger = makeEvent({ tenantId: "ghost", signingKey: "secret-key-1" }, { at: T0 });
  assert.equal((await service.ingest(stranger)).status, "unknown_tenant");
});

test("套餐额度优先抵扣，余额不足不透支且可重试", async () => {
  const { service } = setup();
  service.grantCredit("t-bkk", { amountMicros: 1000 }); // 只够 500 个计费词元

  const first = await service.ingest(makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: T0, eventId: "e1", quantity: 700 }));
  assert.equal(first.status, "accepted");
  assert.equal(first.allowanceQuantity, 500); // 套餐包先抵
  assert.equal(first.amountMicros, 400); // 剩余 200 × 2 微/词元

  const second = await service.ingest(makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: T0, eventId: "e2", quantity: 400 }));
  assert.equal(second.status, "insufficient_funds"); // 需 800，只剩 600

  service.grantCredit("t-bkk", { amountMicros: 1000 });
  const retry = await service.ingest(makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: T0, eventId: "e2", quantity: 400 }));
  assert.equal(retry.status, "accepted"); // 被拒事件不占去重键，充值后可重试
  assert.equal(service.balanceOf("t-bkk").balanceMicros, 800);
});

test("并发扣减不透支预付额度", async () => {
  const { service } = setup();
  service.grantCredit("t-bkk", { amountMicros: 500 }); // 套餐外只够 250 词元
  const events = Array.from({ length: 20 }, (_, i) =>
    makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: T0, eventId: `c${i}`, quantity: 600 }),
  );
  const results = await Promise.all(events.map((e) => service.ingest(e)));
  const accepted = results.filter((r) => r.status === "accepted");
  // 首单 500 走套餐 + 100 计费；之后余额仅够再扣 400 微 → 总计费 ≤ 500
  const totalCharged = accepted.reduce((sum, r) => sum + r.amountMicros, 0);
  assert.ok(totalCharged <= 500, `并发扣款总额 ${totalCharged} 超出预付额度`);
  assert.equal(service.balanceOf("t-bkk").balanceMicros, 500 - totalCharged);
});

test("费率版本只影响生效后的用量", async () => {
  const { service } = setup();
  service.grantCredit("t-bkk", { amountMicros: 10_000 });
  service.publishRate({ rateId: "r2", model: "gpt-a", currency: "THB", microsPerThousand: 9000, effectiveFrom: "2026-09-01T00:00:00Z" });

  const before = await service.ingest(makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: "2026-08-31T23:00:00Z", eventId: "old", quantity: 1000 }));
  const after = await service.ingest(makeEvent({ tenantId: "t-bkk", signingKey: "secret-key-1" }, { at: "2026-09-02T00:00:00Z", eventId: "new", quantity: 1000 }));
  // 8 月套餐包先抵 500，剩余 500 按旧费率 2 微/词元
  assert.equal(before.allowanceQuantity, 500);
  assert.equal(before.amountMicros, 1000);
  assert.equal(after.allowanceQuantity, 500); // 9 月套餐包先抵 500
  assert.equal(after.amountMicros, 4500); // 剩余 500 × 新费率 9 微/词元
});

test("突发限流返回 429 与重试时间", async () => {
  const clock = fakeClock(T0);
  const service = SettlementService.open({ now: () => clock.now });
  service.registerTenant({
    tenantId: "t-sg",
    currency: "SGD",
    signingKey: "secret-key-2",
    rateLimit: { capacity: 2, refillPerSecond: 1 },
  });
  service.publishRate({ rateId: "r1", model: "gpt-a", currency: "SGD", microsPerThousand: 100, effectiveFrom: "2026-01-01T00:00:00Z" });
  service.grantCredit("t-sg", { amountMicros: 10_000 });

  const mk = (id) => makeEvent({ tenantId: "t-sg", signingKey: "secret-key-2" }, { at: T0, eventId: id, quantity: 10 });
  assert.equal((await service.ingest(mk("a"))).status, "accepted");
  assert.equal((await service.ingest(mk("b"))).status, "accepted");
  const limited = await service.ingest(mk("c"));
  assert.equal(limited.status, "throttled");
  assert.ok(limited.retryAfterMs > 0);

  clock.tick(1500); // 令牌回填后恢复
  assert.equal((await service.ingest(mk("c"))).status, "accepted");
});
