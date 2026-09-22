import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettlementService } from "../src/service.mjs";
import { usageEvent } from "./helpers.mjs";

const KEY = "recovery-test-key";

function openService(dataDir) {
  return new SettlementService({
    dataDir,
    signingKey: KEY,
    now: () => Date.parse("2026-01-15T00:00:00Z"),
  });
}

test("故障恢复后状态一致，可继续聚合，重放仍被去重", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "settlement-"));
  try {
    const first = openService(dataDir);
    first.addRateCard({
      model: "gpt-x",
      version: "v1",
      effectiveAt: "2026-01-01T00:00:00Z",
      inputPerMillion: 1,
      outputPerMillion: 2,
      currency: "USD",
    });
    first.topUp({ tenantId: "t1", amount: 1, currency: "USD" });
    first.ingestEvent(usageEvent({ eventId: "e1" }));
    first.ingestEvent(usageEvent({ eventId: "e2", occurredAt: "2026-01-15T00:00:20Z" }));
    first.closePeriod("t1", "2026-01");
    const walletBefore = first.getWallet("t1").wallets[0].balanceMicro;
    const ledgerBefore = first.listLedger("t1").length;

    // 模拟故障重启：同一数据目录重新打开
    const recovered = openService(dataDir);
    assert.equal(recovered.getWallet("t1").wallets[0].balanceMicro, walletBefore);
    assert.equal(recovered.listLedger("t1").length, ledgerBefore);
    assert.deepEqual(recovered.listWindows("t1", "gpt-x"), first.listWindows("t1", "gpt-x"));
    assert.ok(recovered.getInvoice("INV-t1-2026-01"));

    // 重放已处理事件仍是重复，不会二次扣费
    const replay = recovered.ingestEvent(usageEvent({ eventId: "e1" }));
    assert.equal(replay.status, "duplicate");
    assert.equal(recovered.getWallet("t1").wallets[0].balanceMicro, walletBefore);

    // 恢复后可继续聚合：迟到事件进入下一周期
    const late = recovered.ingestEvent(
      usageEvent({ eventId: "e3", occurredAt: "2026-01-20T00:00:00Z" }),
    );
    assert.equal(late.status, "accepted");
    assert.equal(late.periodId, "2026-02");
    assert.equal(late.lateForPeriod, "2026-01");

    // 再次恢复，新事件也在
    const again = openService(dataDir);
    assert.equal(again.getUsageEvent("t1", "e3").periodId, "2026-02");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
