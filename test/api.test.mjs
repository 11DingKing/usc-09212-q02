import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";
import { SettlementService } from "../src/service.mjs";
import { canonicalEvent, signPayload } from "../src/lib/crypto.mjs";

async function withServer(fn) {
  const service = SettlementService.open({});
  const server = createServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, service);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, url) {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: await response.json() };
}

test("HTTP 全链路：配置、签名事件、余额与查询", async () => {
  await withServer(async (base) => {
    const tenant = (await post(base, "/v1/tenants", {
      tenantId: "t-bkk",
      currency: "THB",
      timezone: "Asia/Bangkok",
      signingKey: "secret-key-1",
    })).body;
    assert.equal(tenant.status, "registered");

    assert.equal((await post(base, "/v1/rates", {
      model: "gpt-a",
      currency: "THB",
      microsPerThousand: 2000,
      effectiveFrom: "2026-01-01T00:00:00Z",
    })).body.status, "published");
    assert.equal((await post(base, "/v1/tenants/t-bkk/credit", { amountMicros: 5_000 })).body.status, "granted");

    const event = {
      eventId: "e-http-1",
      tenantId: "t-bkk",
      model: "gpt-a",
      occurredAt: "2026-09-10T08:00:00+07:00",
      quantity: 1000,
      unit: "token",
    };
    event.signature = signPayload("secret-key-1", canonicalEvent(event));
    const accepted = await post(base, "/v1/metering/events", event);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.amountMicros, 2000);

    const balance = await get(base, "/v1/tenants/t-bkk/balance");
    assert.equal(balance.body.balanceMicros, 3000);

    const usage = await get(base, "/v1/tenants/t-bkk/usage?period=2026-09");
    assert.equal(usage.body.models[0].amountMicros, 2000);

    // 签名错误返回 401
    const tampered = { ...event, quantity: 9999, signature: event.signature };
    assert.equal((await post(base, "/v1/metering/events", tampered)).status, 401);
  });
});

test("HTTP 错误状态码映射", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, "/v1/tenants", { tenantId: "x" })).status, 400);
    assert.equal((await get(base, "/v1/tenants/nope/balance")).status, 404);
    assert.equal((await get(base, "/v1/unknown")).status, 404);
  });
});
