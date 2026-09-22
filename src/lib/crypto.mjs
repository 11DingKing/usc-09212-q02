import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// 计量事件的签名载荷：字段顺序固定，调用方与服务端按同一规则拼装。
export function canonicalEvent(event) {
  return [
    event.eventId,
    event.tenantId,
    event.model,
    event.occurredAt,
    String(event.quantity),
    event.unit ?? "token",
  ].join("|");
}

export function signPayload(signingKey, payload) {
  return createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
}

export function verifySignature(signingKey, payload, signature) {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = signPayload(signingKey, payload);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

// 证据摘要：账单行对其全部签名计量证据计算 sha256，供逐项追溯校验。
export function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
