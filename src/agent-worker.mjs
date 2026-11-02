import documentation from "../docs/F-02_cloud-curator.md";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK, USDC } from "./app.mjs";
import { json, MAX_CALLS, CONCURRENCY, AGENT_FEE } from "./agent-contract.mjs";
export { CloudCuratorJob, PaymentClaims } from "./agent-job.mjs";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ready = ["AGENT_WALLET_KEY", "AGENT_LLM_BASE_URL", "AGENT_LLM_MODEL", "AGENT_LLM_API_KEY"].every(key => Boolean(env[key]));
    const seller = ready ? privateKeyToAccount(env.AGENT_WALLET_KEY).address : null;
    if (url.pathname === "/health") return json({ service: "yoyo-x402-cloud-curator", ready, seller, network: NETWORK, asset: USDC, feeAtomic: String(AGENT_FEE), maxCalls: MAX_CALLS, concurrency: CONCURRENCY, model: env.AGENT_LLM_MODEL, docs: "/F-02.md" }, ready ? 200 : 503);
    if (["/", "/F-02.md", "/llms.txt"].includes(url.pathname)) return new Response(documentation.replaceAll("{{BASE_URL}}", url.origin).replaceAll("{{SELLER_ADDRESS}}", seller ?? "not-configured"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    if (!ready) return json({ error: "service_not_configured" }, 503);
    const match = /^\/jobs\/([a-f0-9]{64})(?:\/reconcile)?$/.exec(url.pathname);
    if (!match || url.search) return json({ error: "not_found" }, 404);
    if (request.url.length > 2048 || Number(request.headers.get("content-length")) > 8192) return json({ error: "input_too_large" }, 413);
    if ((request.headers.get("PAYMENT-SIGNATURE")?.length ?? 0) > 8192) return json({ error: "payment_header_too_large" }, 431);
    if (env.AGENT_RATE_LIMITER && !(await env.AGENT_RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" })).success) return json({ error: "rate_limited" }, 429);
    return env.CURATOR_JOBS.get(env.CURATOR_JOBS.idFromName(match[1])).fetch(request);
  },
};
