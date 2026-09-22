import http from "node:http";
import { DomainError, SettlementService } from "./service.mjs";

const ERROR_STATUS = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NO_RATE: 422,
  NO_FX: 422,
  RATE_LIMITED: 429,
};

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new DomainError("VALIDATION", "请求体过大");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("VALIDATION", "请求体不是合法 JSON");
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

// 路由表：[方法, 路径段模式, 处理器(服务, 参数, 查询, 请求体) => [状态码, 响应体]]
const ROUTES = [
  ["GET", "/health", () => [200, { status: "ok" }]],
  ["PUT", "/v1/tenants/:tenantId", (s, p, q, b) => [200, s.upsertTenant(p.tenantId, b)]],
  ["GET", "/v1/tenants/:tenantId", (s, p) => [200, s.getTenant(p.tenantId)]],
  ["POST", "/v1/tenants/:tenantId/subscription", (s, p, q, b) => [201, s.subscribe(p.tenantId, b)]],
  ["POST", "/v1/rate-cards", (s, p, q, b) => [201, s.addRateCard(b)]],
  ["GET", "/v1/rate-cards", (s, p, q) =>
    q.at && q.model ? [200, s.findRateCard(q.model, q.at)] : [200, s.listRateCards(q.model)]],
  ["POST", "/v1/fx-rates", (s, p, q, b) => [201, s.addFxRate(b)]],
  ["POST", "/v1/plans", (s, p, q, b) => [201, s.createPlan(b)]],
  ["POST", "/v1/wallets/topup", (s, p, q, b) => [201, s.topUp(b)]],
  ["GET", "/v1/wallets/:tenantId", (s, p) => [200, s.getWallet(p.tenantId)]],
  ["POST", "/v1/usage-events", (s, p, q, b) => {
    if (Array.isArray(b.events)) {
      // 批量摄入：逐条独立处理，重放安全，单条失败不影响其余
      const results = b.events.map((event) => {
        try {
          return s.ingestEvent(event);
        } catch (error) {
          if (error instanceof DomainError) {
            return { eventId: event?.eventId ?? null, status: "rejected", error: { code: error.code, message: error.message } };
          }
          throw error;
        }
      });
      return [200, { results }];
    }
    return [201, s.ingestEvent(b)];
  }],
  ["GET", "/v1/usage-events/:eventId", (s, p, q) => [200, s.getUsageEvent(q.tenantId, p.eventId)]],
  ["GET", "/v1/evidence/:eventId", (s, p, q) => [200, s.getEvidence(q.tenantId, p.eventId)]],
  ["POST", "/v1/periods/close", (s, p, q, b) => [200, s.closePeriod(b.tenantId, b.periodId)]],
  ["GET", "/v1/invoices", (s, p, q) => [200, s.listInvoices(q.tenantId)]],
  ["GET", "/v1/invoices/:invoiceId", (s, p) => [200, s.getInvoice(p.invoiceId)]],
  ["GET", "/v1/invoices/:invoiceId/verify", (s, p) => [200, s.verifyInvoice(p.invoiceId)]],
  ["POST", "/v1/disputes", (s, p, q, b) => [201, s.dispute(b)]],
  ["GET", "/v1/anomalies", (s, p, q) => [200, s.listAnomalies(q)]],
  ["POST", "/v1/anomalies/:anomalyId/resolve", (s, p, q, b) => [200, s.resolveAnomaly(p.anomalyId, b)]],
  ["GET", "/v1/ledger", (s, p, q) => [200, s.listLedger(q.tenantId, q.periodId)]],
  ["GET", "/v1/windows", (s, p, q) => [200, s.listWindows(q.tenantId, q.model)]],
];

function matchRoute(method, segments) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const patternSegments = pattern.split("/").filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < segments.length; i += 1) {
      if (patternSegments[i].startsWith(":")) {
        params[patternSegments[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (patternSegments[i] !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

export function createServer(options = {}) {
  const service = options.service ?? new SettlementService(options);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      const route = matchRoute(request.method, segments);
      if (!route) {
        send(response, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const body = ["POST", "PUT", "PATCH"].includes(request.method)
        ? await readJsonBody(request)
        : {};
      const [status, payload] = route.handler(service, route.params, query, body);
      send(response, status, payload);
    } catch (error) {
      if (error instanceof DomainError) {
        const headers = {};
        if (error.code === "RATE_LIMITED" && error.details?.retryAfterSec) {
          headers["retry-after"] = String(Math.ceil(error.details.retryAfterSec));
        }
        send(
          response,
          ERROR_STATUS[error.code] ?? 500,
          { error: { code: error.code, message: error.message } },
          headers,
        );
        return;
      }
      send(response, 500, { error: { code: "INTERNAL", message: "服务内部错误" } });
    }
  });
  server.service = service;
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 8000);
  const server = createServer({
    dataDir: process.env.SETTLEMENT_DATA_DIR ?? "./data",
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`用量结算服务已启动: http://127.0.0.1:${port}`);
  });
}
