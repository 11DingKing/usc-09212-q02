import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

test("并发请求下预付额度不可透支", async () => {
  const service = makeService();
  withRateCard(service);
  service.topUp({ tenantId: "t-c", amount: 0.005, currency: "USD" }); // 5000 micro

  const server = createServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    // 50 个并发请求，每个计费 1000 micro，预付只够 5 个
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fetch(`http://127.0.0.1:${port}/v1/usage-events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            usageEvent({ eventId: `c${i}`, tenantId: "t-c", tokensIn: 1000, tokensOut: 0 }),
          ),
        }),
      ),
    );
    for (const response of responses) assert.equal(response.status, 201);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const wallet = service.getWallet("t-c");
  const balance = wallet.wallets.find((w) => w.currency === "USD").balanceMicro;
  assert.equal(balance, 0);
  assert.ok(balance >= 0, "余额不得为负");

  const charges = service.listLedger("t-c").filter((e) => e.type === "charge");
  assert.equal(charges.length, 50);
  assert.equal(charges.reduce((s, c) => s + c.prepaidMicro, 0), 5000);
  assert.equal(charges.reduce((s, c) => s + c.overageMicro, 0), 50 * 1000 - 5000);
});

test("充值按 reference 幂等", () => {
  const service = makeService();
  const first = service.topUp({ tenantId: "t1", amount: 1, currency: "USD", reference: "ref-1" });
  const replay = service.topUp({ tenantId: "t1", amount: 1, currency: "USD", reference: "ref-1" });
  assert.equal(replay.id, first.id);
  const wallet = service.getWallet("t1");
  assert.equal(wallet.wallets[0].balanceMicro, 1_000_000);
});

test("套餐额度先抵扣，超出部分才计价", () => {
  const service = makeService();
  withRateCard(service);
  service.createPlan({ planId: "p-basic", quotas: [{ model: "gpt-x", tokens: 1000 }] });
  service.subscribe("t-plan", { planId: "p-basic" });

  const first = service.ingestEvent(
    usageEvent({ eventId: "p1", tenantId: "t-plan", tokensIn: 600, tokensOut: 600 }),
  );
  assert.equal(first.charge.planCoveredTokens, 1000);
  assert.equal(first.charge.amountMicro, 400); // 仅 200 输出词元计费

  const second = service.ingestEvent(
    usageEvent({ eventId: "p2", tenantId: "t-plan", tokensIn: 600, tokensOut: 600 }),
  );
  assert.equal(second.charge.planCoveredTokens, 0); // 额度已用完
  assert.equal(second.charge.amountMicro, 600 + 1200);
});
