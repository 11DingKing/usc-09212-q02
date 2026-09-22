# 算力词元结算网

面向东盟企业的词元工厂用量结算服务：把算力按量使用的计量、计价、抵扣、
结算与关账独立承接，覆盖从计量事件到月结关账的完整链路。

## 运行

```bash
npm test          # 运行行为测试
npm start         # 启动服务（默认 127.0.0.1:8000）
```

环境变量：

- `PORT`：监听端口（默认 8000）
- `SETTLEMENT_DATA_DIR`：追加日志目录（默认 `./data`）；不设置时纯内存运行
- `SETTLEMENT_SIGNING_KEY`：计量证据 HMAC 签名密钥（生产环境必须设置）

## 核心能力

- **可乱序、可重放的计量摄入**：以 `(租户, 事件ID)` 幂等去重，重放返回
  `duplicate`，不会重复扣费；事件按事件时间归属到租户 + 模型 + UTC 计量窗口。
- **跨时区结算周期**：结算周期为租户时区的自然月，同一物理时刻可按时区
  进入不同周期。
- **费率版本**：按事件发生时间匹配生效版本，新版本不影响历史用量。
- **套餐抵扣**：套餐内词元额度（按周期、按模型）先抵扣，超出部分才计价。
- **预付额度不可透支**：扣减与记账同步原子完成；余额不足部分转为后付
  欠费，钱包永不为负。充值按 `reference` 幂等。
- **多币种结算**：费率币种按事件时间汇率折算为租户结算币种，金额以
  百万分之一单位（micro）整存，避免浮点误差。
- **突发限流**：按租户令牌桶限流，触发返回 429 与 `Retry-After`。
- **争议冲正**：更正只追加冲正分录，历史账目不改写；预付部分即时退回；
  关账后的冲正计入当前未关账周期。
- **关账与迟到事件**：周期关账后出账；迟到事件自动路由到其后第一个
  未关账周期，并保留 `lateForPeriod` 原周期关联。
- **故障恢复**：全部状态变更先写追加日志再应用，重启后重放日志即可
  恢复并继续聚合。
- **签名计量证据**：每条事件生成 HMAC-SHA256 签名证据；账单行逐项携带
  证据引用与聚合签名，可独立核验（`GET /v1/invoices/:id/verify`）。
- **异常峰值处置**：窗口用量超过基线阈值自动标记（`flagged`），处置为
  `confirmed`（维持计费）或 `waived`（自动冲正该窗口全部计费）。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| PUT / GET | `/v1/tenants/:id` | 租户档案（时区、结算币种、限流、异常阈值） |
| POST / GET | `/v1/rate-cards` | 费率版本（`model`、`version`、`effectiveAt`、单价、币种） |
| POST | `/v1/fx-rates` | 汇率（`base`、`quote`、`rate`、`effectiveAt`） |
| POST | `/v1/plans`，`/v1/tenants/:id/subscription` | 套餐与订阅 |
| POST | `/v1/wallets/topup`，GET `/v1/wallets/:tenantId` | 预付充值与余额 |
| POST | `/v1/usage-events` | 计量摄入（单条或 `{events:[...]}` 批量） |
| GET | `/v1/usage-events/:eventId?tenantId=` | 事件及其归属 |
| GET | `/v1/evidence/:eventId?tenantId=` | 签名计量证据 |
| POST | `/v1/periods/close` | 关账出账（`tenantId`、`periodId`） |
| GET | `/v1/invoices`，`/v1/invoices/:id`，`/v1/invoices/:id/verify` | 账单与逐项核验 |
| POST | `/v1/disputes` | 争议冲正（`chargeId` / `eventId` / `lineItemId`） |
| GET | `/v1/anomalies`，POST `/v1/anomalies/:id/resolve` | 异常峰值查询与处置 |
| GET | `/v1/ledger?tenantId=&periodId=` | 追加式账目流水 |
| GET | `/v1/windows?tenantId=&model=` | 计量窗口聚合 |

错误统一为 `{ "error": { "code", "message" } }`；状态码：400 参数错误、
404 不存在、409 冲突（重复关账、重复处置等）、422 缺少费率/汇率、
429 突发限流。
