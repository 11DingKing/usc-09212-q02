// 跨时区时间工具：计量窗口一律按 UTC 毫秒对齐；结算周期（自然月）按租户所在时区界定。
const formatters = new Map();

function dtf(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function assertValidTimezone(timeZone) {
  dtf(timeZone); // 非法时区会抛 RangeError
}

export function zonedParts(ms, timeZone) {
  const parts = {};
  for (const part of dtf(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

// 结算周期标识，如 "2026-01"，按租户时区的自然月划分。
export function periodIdFor(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function offsetMs(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (ms - (ms % 1000));
}

// 某时区本地年月日零点的 UTC 毫秒（迭代收敛，兼容夏令时边界）。
export function zonedTimeToUtcMs(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    guess = target - offsetMs(guess, timeZone);
  }
  return guess;
}

export function periodBounds(periodId, timeZone) {
  const [year, month] = periodId.split("-").map(Number);
  const startMs = zonedTimeToUtcMs(year, month, 1, timeZone);
  const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];
  const endMs = zonedTimeToUtcMs(nextYear, nextMonth, 1, timeZone);
  return { startMs, endMs };
}

export function nextPeriodId(periodId) {
  const [year, month] = periodId.split("-").map(Number);
  const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

// 固定长度计量窗口的起点（UTC 毫秒对齐）。
export function windowStartOf(ms, windowMs) {
  return ms - (((ms % windowMs) + windowMs) % windowMs);
}
