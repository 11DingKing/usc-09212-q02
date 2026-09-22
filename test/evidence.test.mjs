import assert from "node:assert/strict";
import test from "node:test";
import { verifyPayload } from "../src/lib/sign.mjs";
import { makeService, usageEvent, withRateCard } from "./helpers.mjs";

const KEY = "test-signing-key";

test("每条计量事件都有可独立核验的签名证据", () => {
  const service = makeService();
  withRateCard(service);
  service.ingestEvent(usageEvent({ eventId: "v1" }));

  const evidence = service.getEvidence("t1", "v1");
  assert.ok(evidence.valid);
  assert.ok(verifyPayload(KEY, evidence.payload, evidence.signature));

  // 篡改载荷则验签失败
  const tampered = { ...evidence.payload, tokensIn: 999_999 };
  assert.equal(verifyPayload(KEY, tampered, evidence.signature), false);
});

test("账单行可逐项追溯到签名计量证据", () => {
  const service = makeService();
  withRateCard(service);
  service.ingestEvent(usageEvent({ eventId: "v2", occurredAt: "2026-01-15T00:00:10Z" }));
  service.ingestEvent(usageEvent({ eventId: "v3", occurredAt: "2026-01-15T00:01:10Z" }));
  const invoice = service.closePeriod("t1", "2026-01");

  const line = invoice.lines.find((l) => l.kind === "usage");
  assert.deepEqual(line.evidenceRefs, ["v2", "v3"]);
  assert.ok(line.evidenceSignature);

  const verification = service.verifyInvoice(invoice.id);
  assert.equal(verification.valid, true);
  assert.equal(verification.lines[0].evidenceChecked, 2);
});
