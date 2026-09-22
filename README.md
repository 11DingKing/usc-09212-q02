# 算力词元结算网

面向东盟企业的按量算力用量结算服务，独立承接从计量摄取到月底关账的完整链路：
乱序/重放计量事件的签名校验与去重、跨时区时间窗聚合、套餐额度与预付资金并发扣减、
版本化费率、异常峰值处理、争议冲正、迟到事件跨周期归属，以及逐项可追溯的账单证据。

## 运行

```bash
npm test          # 18 项领域与 HTTP 测试
npm start         # 启动服务，默认 127.0.0.1:8000，数据目录 ./data
```

环境变量：`PORT`（默认 8000）、`SETTLEMENT_DATA_DIR`（默认 data，留空为纯内存模式）。

## 核心能力

| 需求 | 实现 |
| --- | --- |
| 乱序/重放计量 | 事件时间与接收时间分离；按 `(租户, 模型, 事件时间窗, eventId)` 幂等去重 |
| 签名证据 | HMAC-SHA256 签名入库；账单行证据摘要可重算校验 |
| 跨时区计量 | `occurredAt` 入口归一化 UTC，UTC 自然月关账，租户时区仅用于展示 |
| 套餐 + 预付 | 额度包按优先级/到期时间优先抵扣；租户级互斥临界区串行扣减，余额不足拒绝、绝不透支 |
| 突发限流 | 每租户令牌桶，超限返回 429 与 `retryAfterMs`，事件不入账 |
| 多币种 | USD/SGD/MYR/THB/PHP/IDR/VND/CNY/JPY，整数微单位计价，BigInt 中间运算 |
| 费率版本 | 按事件时间解析生效版本，新版本不回溯历史用量 |
| 争议更正 | 只追加账本，生成反向冲正条目，原始条目与账单不动 |
| 迟到事件 | 关账后到达自动进入下一未关账周期，保留 `originalPeriod` 关联 |
| 异常峰值 | 滚动基线检测，`pending_review → approved | rejected`，拒绝即逐笔冲正 |
| 关账 | 周期结束后方可关账，不可重开；账单按模型分行并含证据摘要 |
| 故障恢复 | WAL 先写后改 + 原子快照，重启重放继续聚合，重放幂等 |

## 主要接口

```
POST /v1/tenants                 注册租户（币种、时区、签名密钥、套餐、限流配置）
POST /v1/plans                   注册套餐模板（每周期词元额度）
POST /v1/rates                   发布费率版本（effectiveFrom 起按事件时间生效）
POST /v1/tenants/:id/credit      预付充值
POST /v1/tenants/:id/allowances  发放额度包
POST /v1/metering/events         摄取签名计量事件（支持 {events:[...]} 批量）
GET  /v1/tenants/:id/balance     余额与额度包余量
GET  /v1/tenants/:id/usage       按周期/模型/时间窗查询聚合用量
POST /v1/periods/:period/close   关账并出具账单
GET  /v1/invoices/:id            账单
GET  /v1/invoices/:id/evidence   账单行逐项签名计量证据
GET  /v1/invoices/:id/verify     重算证据摘要校验
POST /v1/disputes                争议冲正（entryId 或 usageId）
GET  /v1/anomalies               异常峰值列表（可按状态过滤）
POST /v1/anomalies/:id/review    异常复核 approved/rejected
```

计量事件签名载荷（HMAC-SHA256，字段以 `|` 拼接）：

```
eventId|tenantId|model|occurredAt|quantity|unit
```

领域规则详见 [`docs/domain.md`](docs/domain.md)。
