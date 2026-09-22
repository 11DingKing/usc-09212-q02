import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

async function startServer(service) {
  const server = createServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const post = (base, path, body) => request(base, "POST", path, body);
const put = (base, path, body) => request(base, "PUT", path, body);

test("HTTP 端到端：建档、计价、批量摄入、关账、账单与证据", async () => {
  const service = makeService();
  withRateCard(service);
  const { server, base } = await startServer(service);
  try {
    const tenant = await put(base, "/v1/tenants/t-api", {
      settlementTimezone: "Asia/Singapore",
    });
    assert.equal(tenant.status, 200);

    const topup = await post(base, "/v1/wallets/topup", {
      tenantId: "t-api",
      amount: 1,
      currency: "USD",
    });
    assert.equal(topup.status, 201);

    // 批量摄入：两条新事件 + 一条重放
    const batch = await post(base, "/v1/usage-events", {
      events: [
        usageEvent({ eventId: "a1", tenantId: "t-api" }),
        usageEvent({ eventId: "a2", tenantId: "t-api", occurredAt: "2026-01-15T00:01:10Z" }),
        usageEvent({ eventId: "a1", tenantId: "t-api" }),
      ],
    });
    assert.equal(batch.status, 200);
    assert.deepEqual(
      batch.body.results.map((r) => r.status),
      ["accepted", "accepted", "duplicate"],
    );

    const wallet = await fetch(`${base}/v1/wallets/t-api`).then((r) => r.json());
    assert.equal(wallet.wallets[0].balanceMicro, 1_000_000 - 2 * 2000);

    const closed = await post(base, "/v1/periods/close", { tenantId: "t-api", periodId: "2026-01" });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.id, "INV-t-api-2026-01");

    const invoice = await fetch(`${base}/v1/invoices/INV-t-api-2026-01`).then((r) => r.json());
    assert.equal(invoice.lines[0].evidenceRefs.length, 2);

    const verification = await fetch(`${base}/v1/invoices/INV-t-api-2026-01/verify`).then((r) =>
      r.json(),
    );
    assert.equal(verification.valid, true);

    const evidence = await fetch(`${base}/v1/evidence/a1?tenantId=t-api`).then((r) => r.json());
    assert.equal(evidence.valid, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("突发限流返回 429 与重试提示", async () => {
  const service = makeService();
  withRateCard(service);
  service.upsertTenant("t-rl", { rateLimit: { capacity: 2, refillPerSec: 0.0001 } });
  const { server, base } = await startServer(service);
  try {
    const send = (id) =>
      post(base, "/v1/usage-events", usageEvent({ eventId: id, tenantId: "t-rl" }));
    const first = await send("rl1");
    const second = await send("rl2");
    const third = await send("rl3");
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, "RATE_LIMITED");
    assert.ok(third.headers.get("retry-after"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("未知路由与非法请求体的错误格式", async () => {
  const service = makeService();
  const { server, base } = await startServer(service);
  try {
    const missing = await fetch(`${base}/v1/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    const badJson = await fetch(`${base}/v1/usage-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(badJson.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
