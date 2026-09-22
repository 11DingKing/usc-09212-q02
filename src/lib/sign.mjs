import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./canonical.mjs";

// 计量证据签名：HMAC-SHA256(规范JSON)。持有密钥的任何一方都可独立核验。
export function signPayload(secret, payload) {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

export function verifyPayload(secret, payload, signature) {
  const expected = Buffer.from(signPayload(secret, payload), "hex");
  const given = Buffer.from(String(signature ?? ""), "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
