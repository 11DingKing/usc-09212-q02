// 金额一律以整数微单位（1 货币单位 = 1e6 微单位）计算，避免浮点误差。
export const MICROS_PER_UNIT = 1_000_000;

// 面向东盟企业的常见结算币种；decimals 仅用于展示。
export const CURRENCIES = {
  USD: { decimals: 2 },
  SGD: { decimals: 2 },
  MYR: { decimals: 2 },
  THB: { decimals: 2 },
  PHP: { decimals: 2 },
  IDR: { decimals: 0 },
  VND: { decimals: 0 },
  CNY: { decimals: 2 },
  JPY: { decimals: 0 },
};

export function isSupportedCurrency(code) {
  return Object.hasOwn(CURRENCIES, code);
}

// quantity 个词元按每千词元 microsPerThousand 微单位计价，四舍五入到微单位。
// 使用 BigInt 中间值，杜绝大数量下的精度丢失。
export function priceMicros(quantity, microsPerThousand) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError("quantity 必须是非负安全整数");
  }
  if (!Number.isSafeInteger(microsPerThousand) || microsPerThousand < 0) {
    throw new RangeError("microsPerThousand 必须是非负安全整数");
  }
  const rounded = (BigInt(quantity) * BigInt(microsPerThousand) + 500n) / 1000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("计费金额超出安全整数范围");
  }
  return Number(rounded);
}

export function formatMicros(micros, currency) {
  const decimals = CURRENCIES[currency]?.decimals ?? 2;
  const sign = micros < 0 ? "-" : "";
  const units = Math.abs(micros) / MICROS_PER_UNIT;
  return `${sign}${units.toFixed(decimals)} ${currency}`;
}
