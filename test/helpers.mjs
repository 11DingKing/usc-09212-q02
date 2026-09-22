import { signPayload, canonicalEvent } from "../src/lib/crypto.mjs";
import { toIso } from "../src/lib/time.mjs";

export function makeEvent(tenant, { at = Date.now(), quantity = 1000, model = "gpt-a", eventId = null, unit = "token", signingKey = tenant.signingKey } = {}) {
  const event = {
    eventId: eventId ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: tenant.tenantId,
    model,
    occurredAt: typeof at === "number" ? toIso(at) : at,
    quantity,
    unit,
  };
  return { ...event, signature: signPayload(signingKey, canonicalEvent(event)) };
}

// 可手动拨动的时钟。
export function fakeClock(startMs) {
  return { now: startMs, tick(ms) { this.now += ms; } };
}
