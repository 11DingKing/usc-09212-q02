// 时间与周期工具：内部统一使用 UTC 毫秒，结算周期为 UTC 自然月。
// 跨时区租户的事件时间（可带偏移量）在入口归一化为 UTC，租户时区仅用于展示。

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseUtcMillis(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

export function windowStartOf(ms, windowMs) {
  return Math.floor(ms / windowMs) * windowMs;
}

export function periodOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isValidPeriod(period) {
  return typeof period === "string" && MONTH_RE.test(period);
}

export function periodBounds(period) {
  if (!isValidPeriod(period)) throw new Error(`非法结算周期: ${period}`);
  const [year, month] = period.split("-").map(Number);
  const startMs = Date.UTC(year, month - 1, 1);
  const endMs = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  return { startMs, endMs };
}

export function nextPeriod(period) {
  return periodOf(periodBounds(period).endMs);
}
