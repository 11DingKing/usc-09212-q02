import { SettlementService } from "../src/service.mjs";

export const T0 = Date.parse("2026-01-15T00:00:00Z");

export function makeService(overrides = {}) {
  return new SettlementService({
    signingKey: "test-signing-key",
    now: () => T0,
    ...overrides,
  });
}

export function withRateCard(service, overrides = {}) {
  return service.addRateCard({
    model: "gpt-x",
    version: "v1",
    effectiveAt: "2026-01-01T00:00:00Z",
    inputPerMillion: 1,
    outputPerMillion: 2,
    currency: "USD",
    ...overrides,
  });
}

export function usageEvent(overrides = {}) {
  return {
    eventId: "e1",
    tenantId: "t1",
    model: "gpt-x",
    occurredAt: "2026-01-15T00:00:10Z",
    tokensIn: 1000,
    tokensOut: 500,
    ...overrides,
  };
}
