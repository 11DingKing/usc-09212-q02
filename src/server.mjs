import http from "node:http";
import { SettlementService } from "./service.mjs";
import { formatMicros } from "./lib/money.mjs";

const STATUS_CODES = {
  ok: 200,
  accepted: 201,
  registered: 201,
  granted: 201,
  published: 201,
  corrected: 201,
  closed: 200,
  reviewed: 200,
  duplicate: 200,
  exists: 200,
  invalid: 400,
  invalid_signature: 401,
  unknown_tenant: 404,
  not_found: 404,
  conflict: 409,
  already_reversed: 409,
  already_reviewed: 409,
  period_not_ended: 409,
  throttled: 429,
  insufficient_funds: 422,
  no_rate: 422,
};

function send(response, code, body) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendResult(response, result, extra = {}) {
  send(response, STATUS_CODES[result.status] ?? 200, { ...result, ...extra });
}

function readJson(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

// 匹配 "/v1/tenants/:id/credit" 这类模式，返回参数或 null。
function match(pathname, pattern) {
  const actual = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(":")) params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}

function invoiceView(invoice) {
  return { ...invoice, totalFormatted: formatMicros(invoice.totalMicros, invoice.currency) };
}

export function createServer({ service } = {}) {
  const svc = service ?? SettlementService.open({ dataDir: process.env.SETTLEMENT_DATA_DIR ?? null });

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const method = request.method;
    let params;

    try {
      if (method === "GET" && path === "/health") {
        return send(response, 200, { status: "ok" });
      }

      if (method === "POST" && path === "/v1/tenants") {
        return sendResult(response, svc.registerTenant(await readJson(request)));
      }
      if (method === "POST" && path === "/v1/plans") {
        return sendResult(response, svc.registerPlan(await readJson(request)));
      }
      if (method === "POST" && path === "/v1/rates") {
        return sendResult(response, svc.publishRate(await readJson(request)));
      }
      if (method === "POST" && path === "/v1/metering/events") {
        const body = await readJson(request);
        if (Array.isArray(body.events)) {
          const results = await svc.ingestBatch(body.events);
          return send(response, 200, { results });
        }
        return sendResult(response, await svc.ingest(body));
      }
      if (method === "POST" && path === "/v1/disputes") {
        return sendResult(response, await svc.openDispute(await readJson(request)));
      }
      if (method === "GET" && path === "/v1/anomalies") {
        return sendResult(response, svc.listAnomalies({
          tenantId: url.searchParams.get("tenantId"),
          status: url.searchParams.get("status"),
        }));
      }

      if ((params = match(path, "/v1/tenants/:id")) && method === "GET") {
        return sendResult(response, svc.tenantView(params.id));
      }
      if ((params = match(path, "/v1/tenants/:id/credit")) && method === "POST") {
        return sendResult(response, svc.grantCredit(params.id, await readJson(request)));
      }
      if ((params = match(path, "/v1/tenants/:id/allowances")) && method === "POST") {
        const body = await readJson(request);
        return sendResult(response, svc.grantAllowance({ ...body, tenantId: params.id }));
      }
      if ((params = match(path, "/v1/tenants/:id/balance")) && method === "GET") {
        return sendResult(response, svc.balanceOf(params.id));
      }
      if ((params = match(path, "/v1/tenants/:id/ledger")) && method === "GET") {
        return sendResult(response, svc.ledgerOf(params.id));
      }
      if ((params = match(path, "/v1/tenants/:id/usage")) && method === "GET") {
        return sendResult(response, svc.usageOf(params.id, url.searchParams.get("period")));
      }
      if ((params = match(path, "/v1/tenants/:id/invoices")) && method === "GET") {
        const result = svc.invoicesOf(params.id);
        if (result.status !== "ok") return sendResult(response, result);
        return send(response, 200, { ...result, invoices: result.invoices.map(invoiceView) });
      }
      if ((params = match(path, "/v1/tenants/:id/disputes")) && method === "GET") {
        return sendResult(response, svc.disputesOf(params.id));
      }
      if ((params = match(path, "/v1/periods/:period/close")) && method === "POST") {
        const body = await readJson(request);
        const result = await svc.closePeriod(params.period, body.tenantId ?? null);
        if (result.status !== "closed") return sendResult(response, result);
        return send(response, 200, { ...result, invoices: result.invoices.map(invoiceView) });
      }
      if ((params = match(path, "/v1/invoices/:id")) && method === "GET") {
        const result = svc.invoiceOf(params.id);
        if (result.status !== "ok") return sendResult(response, result);
        return send(response, 200, { status: "ok", invoice: invoiceView(result.invoice) });
      }
      if ((params = match(path, "/v1/invoices/:id/evidence")) && method === "GET") {
        return sendResult(response, svc.invoiceEvidence(params.id));
      }
      if ((params = match(path, "/v1/invoices/:id/verify")) && method === "GET") {
        return sendResult(response, svc.verifyInvoice(params.id));
      }
      if ((params = match(path, "/v1/anomalies/:id/review")) && method === "POST") {
        return sendResult(response, svc.reviewAnomaly(params.id, await readJson(request)));
      }

      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error.message === "invalid_json") return send(response, 400, { error: "invalid_json" });
      if (error.message === "payload_too_large") return send(response, 413, { error: "payload_too_large" });
      return send(response, 500, { error: "internal_error" });
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 8000);
  const dataDir = process.env.SETTLEMENT_DATA_DIR ?? "data";
  const service = SettlementService.open({ dataDir });
  createServer({ service }).listen(port, "127.0.0.1", () => {
    console.log(`用量结算服务已启动: http://127.0.0.1:${port} (数据目录: ${dataDir})`);
  });
}
