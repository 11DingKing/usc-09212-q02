// 稳定序列化：键排序后的 JSON，用于签名与校验，保证同一载荷处处得到同一字节串。
export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",");
  return `{${body}}`;
}
