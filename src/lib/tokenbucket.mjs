// 令牌桶：按租户限制突发请求。桶为运行时状态，不进入日志。
export class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.updatedAtMs = null;
  }

  tryTake(nowMs) {
    if (this.updatedAtMs === null) this.updatedAtMs = nowMs;
    const elapsedSec = Math.max(0, (nowMs - this.updatedAtMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.updatedAtMs = nowMs;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const retryAfterSec = this.refillPerSec > 0 ? (1 - this.tokens) / this.refillPerSec : 3600;
    return { ok: false, retryAfterSec };
  }
}
