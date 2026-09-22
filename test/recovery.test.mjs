import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SettlementService } from "../src/service.mjs";
import { makeEvent, fakeClock } from "./helpers.mjs";

const T0 = Date.parse("2026-09-10T08:00:00Z");

function freshDir(name) {
  const dir = path.join(os.tmpdir(), `settlement-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

test("重启后通过 WAL 重放继续聚合，重放幂等", () => {
  const dir = freshDir("wal");
  const clock = fakeClock(T0);
  const open = () => SettlementService.open({ dataDir: dir, now: () => clock.now });

  let service = open();
  service.registerTenant({ tenantId: "t1", currency: "USD", signingKey: "secret-key-1" });
  service.publishRate({ rateId: "r1", model: "gpt-a", currency: "USD", microsPerThousand: 1000, effectiveFrom: "2026-01-01T00:00:00Z" });
  service.grantCredit("t1", { amountMicros: 10_000_000 });
  clock.tick(1000);
  // 测试内直接用 ingest 不方便 await 的场景较少，这里同步准备后用 await 包一层
  return (async () => {
    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0, eventId: "e1", quantity: 1000 }));
    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0, eventId: "e1", quantity: 1000 }));
    assert.equal(service.balanceOf("t1").balanceMicros, 9_999_000);

    service = open(); // 模拟故障重启：仅靠 WAL 重放
    assert.equal(service.balanceOf("t1").balanceMicros, 9_999_000);
    const replay = await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0, eventId: "e1", quantity: 1000 }));
    assert.equal(replay.status, "duplicate"); // 去重状态随日志恢复

    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0, eventId: "e2", quantity: 2000 }));
    assert.equal(service.usageOf("t1", "2026-09").models[0].quantity, 3000); // 跨重启继续聚合
    assert.equal(service.balanceOf("t1").balanceMicros, 9_997_000);
    rmSync(dir, { recursive: true, force: true });
  })();
});

test("快照后只增量重放日志，状态一致", () => {
  const dir = freshDir("snapshot");
  const clock = fakeClock(T0);

  return (async () => {
    let service = SettlementService.open({ dataDir: dir, now: () => clock.now });
    service.registerTenant({ tenantId: "t1", currency: "USD", signingKey: "secret-key-1" });
    service.publishRate({ rateId: "r1", model: "gpt-a", currency: "USD", microsPerThousand: 1000, effectiveFrom: "2026-01-01T00:00:00Z" });
    service.grantCredit("t1", { amountMicros: 10_000_000 });
    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0, eventId: "e1", quantity: 1000 }));
    const cp = service.checkpoint();
    assert.equal(cp.status, "checkpointed");

    await service.ingest(makeEvent({ tenantId: "t1", signingKey: "secret-key-1" }, { at: T0, eventId: "e2", quantity: 1000 }));

    service = SettlementService.open({ dataDir: dir, now: () => clock.now }); // 快照 + 增量重放
    const usage = service.usageOf("t1", "2026-09");
    assert.equal(usage.models[0].quantity, 2000);
    assert.equal(service.balanceOf("t1").balanceMicros, 9_998_000);

    clock.now = Date.parse("2026-10-02T00:00:00Z");
    const closed = await service.closePeriod("2026-09");
    assert.equal(closed.invoices[0].usageCount, 2);
    rmSync(dir, { recursive: true, force: true });
  })();
});
