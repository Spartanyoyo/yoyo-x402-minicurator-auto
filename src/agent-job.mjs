import { privateKeyToAccount } from "viem/accounts";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { NETWORK, USDC, FACILITATOR } from "./app.mjs";
import { balances } from "../scripts/chain.mjs";
import { CloudCuratorJob as LegacyJob, PaymentClaims, ingressRequirement, validIngress } from "./agent-legacy-job.mjs";
import { JsonStore, sha256, json, curationInput, curationIdentity, validateCalls, callKey, mapLimited, RETENTION_MS, AGENT_FEE, DIRECT_ROUNDS, MODEL_LIMIT, readTextBounded, safeError } from "./agent-contract.mjs";
import { planNext, composeReport, detailedWorks } from "./agent-model.mjs";
import { directTool, missingMuseums, continuationCalls } from "./agent-tools.mjs";
import { workerRpc, incrementalAudit, reconcilePayment } from "./agent-payment.mjs";
import { publicEvidence } from "./agent-evidence.mjs";
export { PaymentClaims, ingressRequirement, validIngress };

const stamp = () => new Date().toISOString();
const idle = new Set(["ready", "complete", "needs_attention", "failed", "payment_retry_allowed"]);
const rpcTransient = error => /RPC|subrequests|block.*(?:not.*found|unavailable)|header not found|timeout|timed out|socket|network|fetch failed|receipt.*not.*found/i.test(String(error?.message));

export class CloudCuratorJob {
  constructor(ctx, env, dependencies = {}) {
    this.ctx = ctx; this.env = env; this.dependencies = dependencies; this.store = new JsonStore(ctx.storage); this.active = false;
    this.facilitator = dependencies.facilitator ?? new HTTPFacilitatorClient({ url: FACILITATOR });
    this.tool = dependencies.tool ?? (call => directTool(call, { cache: globalThis.caches?.default }));
    this.plan = dependencies.plan ?? planNext; this.compose = dependencies.compose ?? composeReport;
    this.rpcFactory = dependencies.rpcFactory ?? (job => workerRpc(env, job));
    this.auditPayment = dependencies.auditPayment ?? ((record, rpc, persist) => incrementalAudit(record, rpc, persist, { expectedAmount: String(AGENT_FEE), allowConcurrentTransfers: true, deliveryStatus: 202, validateDelivery: response => { if (response.jobId !== record.jobId || response.reportSha256 !== record.reportSha256) throw new Error("Payment does not bind this completed report"); } }));
    this.reconcilePayment = dependencies.reconcilePayment ?? reconcilePayment;
  }
  legacy() { return this.legacyInstance ??= new LegacyJob(this.ctx, this.env, this.dependencies); }
  async save(job) { job.updatedAt = stamp(); await this.store.put("job", job); }
  async records(job) { return (await Promise.all(job.calls.map(call => this.store.get(`resource:${call.key}`)))).filter(Boolean); }
  async schedule(job, delay = 1000) {
    await this.save(job);
    await this.ctx.storage.setAlarm(idle.has(job.status) ? Date.parse(job.expiresAt) : Date.now() + delay);
  }
  async response(job) {
    const result = { protocolVersion: 2, jobId: job.id, requestId: job.requestId, status: job.status, input: job.input, createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt, calls: job.calls.map(({ service, parameters, state, attempts }) => ({ service, parameters, state, attempts })), rounds: job.rounds, modelCalls: job.modelCalls, feeAtomic: String(AGENT_FEE), totalUpstreamAtomic: "0", summary: job.summary, error: job.error, retry: job.retry, incoming: job.incoming };
    if (job.status === "complete" && job.incoming?.audit?.paymentVerified) result.delivery = await this.store.get("delivery");
    const headers = { "X-Request-Id": job.requestId };
    if (job.incoming?.settlement?.success) headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader(job.incoming.settlement);
    return json(publicEvidence(result), ["ready", "complete", "failed", "needs_attention", "payment_retry_allowed"].includes(job.status) ? 200 : 202, headers);
  }
  quote(job, request) {
    const seller = privateKeyToAccount(this.env.AGENT_WALLET_KEY).address;
    const quote = { x402Version: 2, resource: { url: request.url, description: `Completed cloud exhibition ${job.summary.reportSha256}; fixed service fee, free upstream APIs`, mimeType: "application/json" }, accepts: [ingressRequirement(seller, String(AGENT_FEE))] };
    return json({ ...quote, jobId: job.id, summary: job.summary }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(quote), "X-Request-Id": job.requestId });
  }
  async fetch(request) {
    let job = await this.store.get("job");
    if (job && job.protocolVersion !== 2) return this.legacy().fetch(request);
    const url = new URL(request.url);
    const match = /^\/jobs\/([a-f0-9]{64})(\/(?:delivery|reconcile))?$/.exec(url.pathname);
    if (!match || url.search) return json({ error: "not_found" }, 404);
    const id = match[1]; const action = match[2];
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (!/^[a-f0-9]{64}$/.test(token ?? "") || job && (job.id !== id || job.tokenHash !== sha256(token))) return json({ error: "unauthorized" }, 401);
    if (job && Date.now() >= Date.parse(job.expiresAt)) return json({ error: "expired" }, 410);
    if (request.method === "GET") {
      if (!job) return json({ error: "not_found" }, 404);
      if (action === "/delivery" && ["ready", "payment_retry_allowed"].includes(job.status)) return this.quote(job, request);
      return this.response(job);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (this.active) return job ? this.response(job) : json({ jobId: id, status: "busy" }, 202);
    this.active = true;
    try {
      if (action === "/reconcile") {
        if (!job) return json({ error: "not_found" }, 404);
        if (job.incoming && !job.incoming.audit?.paymentVerified && job.status !== "payment_retry_allowed") {
          job.status = job.incoming.submittedAt
            ? job.incoming.settlement?.success ? "auditing_payment" : "reconciling_payment"
            : job.incoming.before ? "settling_payment" : "preparing_payment";
        }
        else if (job.status === "needs_attention" && job.resumeStatus) job.status = job.resumeStatus;
        else return this.response(job);
        delete job.error; delete job.retry; await this.schedule(job); return this.response(job);
      }
      if (action === "/delivery") {
        if (!job) return json({ error: "not_found" }, 404);
        if (job.status === "complete" || job.incoming && job.status !== "payment_retry_allowed") return this.response(job);
        if (!["ready", "payment_retry_allowed"].includes(job.status)) return json({ error: "result_not_ready", jobId: id, status: job.status }, 409);
        const signature = request.headers.get("PAYMENT-SIGNATURE");
        if (!signature) return this.quote(job, request);
        if (signature.length > 8192) return json({ error: "payment_header_too_large" }, 431);
        const seller = privateKeyToAccount(this.env.AGENT_WALLET_KEY).address;
        const requirement = ingressRequirement(seller, String(AGENT_FEE));
        const payload = decodePaymentSignatureHeader(signature);
        if (!validIngress(payload, requirement, request.url)) return json({ error: "invalid_payment_terms" }, 400);
        if (!(await this.facilitator.verify(payload, requirement)).isValid) return json({ error: "payment_verification_failed" }, 402);
        const authorization = payload.payload.authorization;
        if (job.incoming?.authorization.nonce.toLowerCase() === authorization.nonce.toLowerCase()) return json({ error: "expired_nonce_must_not_be_resubmitted" }, 409);
        const claim = await this.env.PAYMENT_CLAIMS.get(this.env.PAYMENT_CLAIMS.idFromName("claims")).fetch("https://internal/claim", { method: "POST", body: JSON.stringify({ payer: authorization.from, nonce: authorization.nonce, jobId: id, validBefore: authorization.validBefore }) });
        if (!claim.ok) return json({ error: "authorization_already_bound_or_quota_exceeded" }, 409);
        if (job.incoming) { job.priorPayments ??= []; job.priorPayments.push(job.incoming); }
        job.incoming = { jobId: id, requestId: job.requestId, reportSha256: job.summary.reportSha256, at: stamp(), buyer: authorization.from, seller, network: NETWORK, asset: USDC, authorization: { ...authorization }, status: "accepted_not_submitted", http: [{ paid: true, status: 202, receivedAt: stamp(), headers: { "x-request-id": job.requestId } }], response: { requestId: job.requestId, jobId: id, reportSha256: job.summary.reportSha256 } };
        await this.store.put("pending-payment", payload);
        job.status = "preparing_payment"; delete job.retry; delete job.error; await this.schedule(job);
        return this.response(job);
      }
      const input = curationInput(JSON.parse(await readTextBounded(request, 8192)));
      if (curationIdentity(input, token) !== id) return json({ error: "job_id_does_not_bind_goal_and_token" }, 409);
      if (job) return this.response(job);
      const quota = await this.env.PAYMENT_CLAIMS.get(this.env.PAYMENT_CLAIMS.idFromName("claims")).fetch("https://internal/prepare", { method: "POST", body: JSON.stringify({ jobId: id, ipHash: sha256(request.headers.get("CF-Connecting-IP") ?? "unknown") }) });
      if (!quota.ok) return json({ error: "preparation_quota_exceeded", message: "Daily preparation limit reached; no payment was requested" }, 429);
      job = { protocolVersion: 2, id, input, tokenHash: sha256(token), requestId: crypto.randomUUID(), status: "queued", createdAt: stamp(), expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(), calls: [], rounds: 0, modelCalls: 0, modelEvidence: [] };
      await this.schedule(job); return this.response(job);
    } catch (error) { return json({ error: "request_failed", message: safeError(error) }, rpcTransient(error) ? 503 : 400); }
    finally { this.active = false; }
  }
  async alarm() {
    if (this.active) { await this.ctx.storage.setAlarm(Date.now() + 15000); return; }
    this.active = true;
    try {
      const job = await this.store.get("job");
      if (!job) return;
      if (job.protocolVersion !== 2) return await this.legacy().alarm();
      if (Date.now() >= Date.parse(job.expiresAt)) { await this.ctx.storage.deleteAll(); return; }
      if (idle.has(job.status)) { await this.ctx.storage.setAlarm(Date.parse(job.expiresAt)); return; }
      await this.ctx.storage.setAlarm(Date.now() + 120000);
      const phase = job.status;
      try {
        await this.step(job);
        delete job.retry; delete job.error;
        const delay = job.nextDelay ?? 1000; delete job.nextDelay; await this.schedule(job, delay);
      } catch (error) {
        const yielded = /invocation budget reached/i.test(String(error.message));
        const count = yielded ? job.retry?.attempts ?? 0 : (job.retry?.attempts ?? 0) + 1;
        const recoverable = yielded || rpcTransient(error) || /Model API HTTP (?:429|5\d\d)|Model output incomplete|JSON/i.test(String(error.message));
        if (recoverable && count <= 6) {
          if (!yielded && rpcTransient(error)) job.rpcCursor = (job.rpcCursor ?? 0) + 1;
          job.retry = { phase, attempts: count, nextCheckAt: new Date(Date.now() + Math.min(60000, 2000 * 2 ** count)).toISOString(), reason: safeError(error) };
          if (job.incoming?.submittedAt && !job.incoming.settlement?.success) job.status = "reconciling_payment";
          await this.schedule(job, yielded ? 1000 : Math.min(60000, 2000 * 2 ** count));
        } else {
          job.resumeStatus = job.incoming?.submittedAt && !job.incoming.settlement?.success ? "reconciling_payment" : job.status;
          job.status = job.incoming ? "needs_attention" : "failed"; job.error = safeError(error); await this.schedule(job);
        }
      }
    } finally { this.active = false; }
  }
  async step(job) {
    if (["preparing_payment", "settling_payment", "auditing_payment", "reconciling_payment"].includes(job.status)) return this.paymentStep(job);
    const records = await this.records(job);
    if (["queued", "planning"].includes(job.status)) {
      const missing = missingMuseums(records);
      if (!missing.length) { job.status = "composing"; return; }
      const remaining = job.input.maxCalls - job.calls.length;
      if (remaining <= 0) throw new Error(`Request limit exhausted; missing ${missing.join(", ")}; no result or payment offered`);
      let calls = continuationCalls(job, records, remaining);
      if (!calls.length) {
        if (job.rounds >= DIRECT_ROUNDS || job.modelCalls >= MODEL_LIMIT - 1) throw new Error(`Planning limit reached; missing ${missing.join(", ")}; no payment requested`);
        job.status = "planning"; job.modelCalls++; await this.save(job);
        const plan = await this.plan(this.env, job, records);
        job.rounds++; job.modelEvidence.push(plan.evidence);
        calls = validateCalls(plan.output, remaining);
        if (plan.output.finish) { job.plannerFeedback = `Finish rejected: obtain valid details for ${missing.join(", ")}; requests remain available.`; job.status = "queued"; return; }
      }
      const seen = new Set(job.calls.map(call => call.key));
      job.batch = calls.map(call => ({ ...call, key: callKey(call), state: "queued", attempts: 0 })).filter(call => { if (seen.has(call.key)) return false; seen.add(call.key); return true; });
      if (!job.batch.length) { job.plannerFeedback = "Repeated calls rejected. Choose a different available ID, advance offset, or adjust the search query."; job.status = "queued"; return; }
      job.calls.push(...job.batch); job.status = "fetching"; return;
    }
    if (job.status === "fetching") {
      const batch = job.batch.map(call => job.calls.find(saved => saved.key === call.key));
      const results = await mapLimited(batch, 3, async call => {
        const existing = await this.store.get(`resource:${call.key}`);
        if (["ok", "unavailable", "failed"].includes(existing?.status)) { call.state = existing.status; return; }
        if (call.attempts >= 3) { await this.store.put(`resource:${call.key}`, { resourceService: call.service, parameters: call.parameters, status: "failed", error: "Free GET attempt limit reached after interruption" }); call.state = "failed"; return; }
        call.attempts++; await this.save(job);
        const record = await this.tool(call);
        if (record.status === "retryable" && call.attempts >= 3) record.status = "failed";
        await this.store.put(`resource:${call.key}`, record); call.state = record.status;
      });
      if (results.some(result => result.status === "rejected")) throw new Error(results.find(result => result.status === "rejected").reason);
      const outcomes = await Promise.all(batch.map(call => this.store.get(`resource:${call.key}`)));
      if (outcomes.some(record => !record)) throw new Error("Resource checkpoint missing after fetch");
      if (outcomes.some(record => record.status === "retryable")) { job.nextDelay = 3000; return; }
      job.batch = []; job.status = "queued"; return;
    }
    if (job.status === "composing") {
      if (missingMuseums(records).length) { job.status = "queued"; return; }
      if (job.modelCalls >= MODEL_LIMIT) throw new Error("Model request limit reached; no payment requested");
      job.modelCalls++; await this.save(job);
      const answer = await this.compose(this.env, job, records);
      job.modelEvidence.push(answer.evidence);
      const delivery = { protocolVersion: 2, goal: job.input.goal, reportMarkdown: answer.report, reportSha256: sha256(answer.report), resources: records, purchases: [], modelEvidence: job.modelEvidence, generatedAt: stamp(), totalUpstreamAtomic: "0", feeAtomic: String(AGENT_FEE) };
      await this.store.put("delivery", delivery);
      job.summary = { reportSha256: delivery.reportSha256, providers: ["Met", "CMA", "SMK"], workCount: detailedWorks(records).length, generatedAt: delivery.generatedAt, priceAtomic: String(AGENT_FEE), paymentPath: `/jobs/${job.id}/delivery` };
      job.status = "ready"; return;
    }
    throw new Error("Unknown curation job phase");
  }
  async paymentStep(job) {
    const record = job.incoming;
    if (!record || !job.summary) throw new Error("Payment has no completed report");
    const persist = async value => { job.incoming = value; await this.save(job); };
    if (job.status === "preparing_payment") {
      const rpc = this.rpcFactory(job);
      if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
      record.before = await balances(rpc, record.buyer, record.seller, await rpc.getBlockNumber({ cacheTime: 0 }));
      await persist(record); job.status = "settling_payment"; return;
    }
    if (job.status === "settling_payment") {
      if (record.submittedAt) { job.status = "reconciling_payment"; return; }
      const payload = await this.store.get("pending-payment");
      if (!payload) throw new Error("Private payment payload missing; reconcile before any new authorization");
      record.submittedAt = stamp(); record.status = "payment_submitted_outcome_pending"; await this.save(job);
      try { record.settlement = await this.facilitator.settle(payload, ingressRequirement(record.seller, String(AGENT_FEE))); }
      catch { job.status = "reconciling_payment"; await this.save(job); return; }
      job.status = record.settlement?.success ? "auditing_payment" : "reconciling_payment"; return;
    }
    const rpc = this.rpcFactory(job);
    if (job.status === "reconciling_payment" && !record.settlement?.success) {
      const outcome = await this.reconcilePayment(record, rpc, persist);
      if (outcome === "confirmed_unpaid") { job.status = "payment_retry_allowed"; return; }
      if (outcome !== "settled") { job.nextDelay = 15000; return; }
      job.status = "auditing_payment"; return;
    }
    await this.auditPayment(record, rpc, persist);
    if (!record.audit?.paymentVerified || record.status !== "verified") throw new Error("Incoming payment audit did not verify exact transfer, authorization, balances and report binding");
    job.status = "complete";
  }
}
