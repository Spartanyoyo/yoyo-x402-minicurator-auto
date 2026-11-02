import { privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { NETWORK, USDC, FACILITATOR } from "./app.mjs";
import { purchaseCurator, validateCuratorDelivery } from "../scripts/curator-purchase.mjs";
import { auditPurchase, balances, chainClient } from "../scripts/chain.mjs";
import { reconcilePurchase } from "../scripts/reconcile.mjs";
import { JsonStore, sha256, json, taskInput, taskIdentity, paymentAmount, validateCalls, callKey, mapLimited, CONCURRENCY, MAX_ROUNDS, RETENTION_MS, readTextBounded } from "./agent-contract.mjs";
import { planNext, composeReport } from "./agent-model.mjs";
import { SERVICES } from "./curator-catalog.mjs";
import { publicEvidence } from "./agent-evidence.mjs";

const terminal = new Set(["complete", "needs_attention", "expired"]);
const stamp = () => new Date().toISOString();
export function ingressRequirement(payTo, amount) {
  return { scheme: "exact", network: NETWORK, asset: USDC, amount, payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
}
export function validIngress(payload, requirement, url) {
  const a = payload?.accepted; const auth = payload?.payload?.authorization;
  return payload?.x402Version === 2 && payload.resource?.url === url && a &&
    ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"].every(k => String(a[k]).toLowerCase() === String(requirement[k]).toLowerCase()) &&
    a.extra?.name === "USDC" && a.extra?.version === "2" && !a.extra?.assetTransferMethod && !a.extra?.paymentFlow &&
    isAddress(auth?.from ?? "") && auth.from.toLowerCase() !== requirement.payTo.toLowerCase() && auth?.to?.toLowerCase() === requirement.payTo.toLowerCase() && auth.value === requirement.amount &&
    /^0x[0-9a-f]{64}$/i.test(auth.nonce ?? "") && /^\d+$/.test(auth.validAfter ?? "") && /^\d+$/.test(auth.validBefore ?? "") && Number(auth.validBefore) > Date.now() / 1000 && Number(auth.validBefore) <= Date.now() / 1000 + 310;
}

export class PaymentClaims {
  constructor(ctx, env = {}, dependencies = {}) { this.ctx = ctx; this.env = env; this.fetcher = dependencies.fetcher ?? ((input, init) => fetch(input, init)); this.tail = Promise.resolve(); }
  async fetch(request) {
    if (new URL(request.url).pathname === "/outbound") {
      const operation = this.tail.then(() => this.outbound(request));
      this.tail = operation.catch(() => {}); return operation;
    }
    const { payer, nonce, jobId, validBefore } = await request.json();
    if (!isAddress(payer) || !/^0x[0-9a-f]{64}$/i.test(nonce ?? "") || !/^[a-f0-9]{64}$/.test(jobId ?? "")) return json({ error: "invalid_claim" }, 400);
    const key = `${payer.toLowerCase()}:${nonce.toLowerCase()}`;
    const accepted = await this.ctx.storage.transaction(async tx => {
      const prior = await tx.get(key);
      if (prior) return prior.jobId === jobId;
      const day = `daily:${new Date().toISOString().slice(0, 10)}`;
      const usage = await tx.get(day) ?? { count: 0, expires: Date.now() + 2 * 86400000 };
      if (usage.count >= 10) return false;
      usage.count++; await tx.put(day, usage);
      await tx.put(key, { jobId, expires: Number(validBefore) * 1000 + RETENTION_MS });
      return true;
    });
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 86400000);
    return json({ accepted }, accepted ? 200 : 409);
  }
  async outbound(request) {
    const input = await request.json(); const target = new URL(input.url);
    if (target.origin !== this.env.CURATOR_SERVER_URL || target.username || target.password || target.hash || !Object.values(SERVICES).some(service => service.path === target.pathname)) return json({ error: "unapproved_outbound_target" }, 400);
    const header = input.headers?.["payment-signature"];
    if (!header || header.length > 8192) return json({ error: "invalid_outbound_payment" }, 400);
    const payment = decodePaymentSignatureHeader(header); const authorization = payment.payload.authorization;
    const previous = await this.ctx.storage.get("outbound-lease");
    if (previous && previous.expires > Date.now()) return json({ error: "outbound_payment_pending_reconciliation" }, 503);
    await this.ctx.storage.put("outbound-lease", { nonce: authorization.nonce, expires: Number(authorization.validBefore) * 1000 + 10000 });
    // The public facilitator shares a relayer nonce. Serialize paid HTTP, while
    // documentation, quotes, model work and independent audits remain parallel.
    const response = await this.fetcher(target.href, { headers: input.headers, redirect: "manual", signal: AbortSignal.timeout(90000) });
    const body = await readTextBounded(response);
    await this.ctx.storage.delete("outbound-lease");
    return new Response(body, { status: response.status, headers: response.headers });
  }
  async alarm() {
    const entries = await this.ctx.storage.list({ limit: 1000 });
    for (const [key, value] of entries) if (value.expires < Date.now()) await this.ctx.storage.delete(key);
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}

export class CloudCuratorJob {
  constructor(ctx, env, dependencies = {}) {
    this.ctx = ctx; this.env = env; this.store = new JsonStore(ctx.storage); this.active = false;
    this.rpc = dependencies.rpc ?? chainClient({ env });
    this.facilitator = dependencies.facilitator ?? new HTTPFacilitatorClient({ url: FACILITATOR });
    this.purchase = dependencies.purchase ?? purchaseCurator; this.plan = dependencies.plan ?? planNext; this.compose = dependencies.compose ?? composeReport;
    this.audit = dependencies.audit ?? auditPurchase; this.reconcile = dependencies.reconcile ?? ((record, rpc) => reconcilePurchase(record, rpc, { allowConcurrentTransfers: true, maxBlocks: 1800 }));
  }
  async save(job) { job.updatedAt = stamp(); await this.store.put("job", job); }
  async records(job) { return Promise.all(job.calls.map(call => this.store.get(`purchase:${call.key}`))).then(items => items.filter(Boolean)); }
  async response(job) {
    const result = { requestId: job.requestId, jobId: job.id, status: job.status, input: job.input, createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt, budget: { reservedAtomic: String(job.calls.length * 1000), maximumAtomic: job.input.budgetAtomic }, calls: job.calls.map(({ service, parameters }) => ({ service, parameters })), rounds: job.rounds, error: job.error, incoming: job.incoming };
    result.modelCalls = job.modelCalls;
    result.errorTrace = job.errorTrace;
    if (job.status === "needs_attention") result.purchaseEvidence = await this.records(job);
    if (job.status === "complete") result.delivery = await this.store.get("delivery");
    const headers = { "X-Request-Id": job.requestId };
    if (job.incoming?.settlement?.success) headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader(job.incoming.settlement);
    return json(publicEvidence(result), job.status === "complete" ? 200 : 202, headers);
  }
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const match = /^\/jobs\/([a-f0-9]{64})(\/reconcile)?$/.exec(url.pathname);
      if (!match || url.search) return json({ error: "not_found" }, 404);
      const id = match[1]; const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
      if (!/^[a-f0-9]{64}$/.test(token ?? "")) return json({ error: "unauthorized" }, 401);
      let job = await this.store.get("job");
      if (job && (job.id !== id || job.tokenHash !== sha256(token))) return json({ error: "unauthorized" }, 401);
      if (job && Date.now() >= Date.parse(job.expiresAt)) return json({ error: "expired" }, 410);
      if (request.method === "GET" && !match[2]) return job ? this.response(job) : json({ error: "not_found" }, 404);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (this.active) return json({ jobId: id, status: "busy" }, 202);
      this.active = true;
      try {
        if (match[2]) {
          if (!job) return json({ error: "not_found" }, 404);
          await this.recover(job); return this.response(job);
        }
        const input = taskInput(JSON.parse(await readTextBounded(request, 8192)));
        if (taskIdentity(input, token) !== id) return json({ error: "job_id_does_not_bind_goal_and_token" }, 409);
        if (!job) {
          job = { id, input, tokenHash: sha256(token), requestId: crypto.randomUUID(), status: "awaiting_payment", createdAt: stamp(), expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(), calls: [], rounds: 0, modelCalls: 0, modelEvidence: [] };
          await this.save(job); await this.ctx.storage.setAlarm(Date.now() + 3600000);
        }
        if (job.incoming) return this.response(job); // Recovery uses read-only reconciliation, never a second settlement.
        const seller = privateKeyToAccount(this.env.AGENT_WALLET_KEY).address;
        const requirement = ingressRequirement(seller, paymentAmount(input));
        const signature = request.headers.get("PAYMENT-SIGNATURE");
        if (!signature) {
          const quote = { x402Version: 2, resource: { url: request.url, description: "Cloud museum curation job, prepaid testnet service; includes authenticated redelivery", mimeType: "application/json" }, accepts: [requirement] };
          return json(quote, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(quote) });
        }
        if (signature.length > 8192) return json({ error: "payment_header_too_large" }, 431);
        const payload = decodePaymentSignatureHeader(signature);
        if (!validIngress(payload, requirement, request.url)) return json({ error: "invalid_payment_terms" }, 400);
        const verified = await this.facilitator.verify(payload, requirement);
        if (!verified.isValid) return json({ error: "payment_verification_failed" }, 402);
        const authorization = payload.payload.authorization;
        const claim = await this.env.PAYMENT_CLAIMS.get(this.env.PAYMENT_CLAIMS.idFromName("claims")).fetch("https://internal/claim", { method: "POST", body: JSON.stringify({ payer: authorization.from, nonce: authorization.nonce, jobId: id, validBefore: authorization.validBefore }) });
        if (!claim.ok) return json({ error: "authorization_already_bound_to_another_job" }, 409);
        if (await this.rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
        const before = await balances(this.rpc, authorization.from, seller, await this.rpc.getBlockNumber({ cacheTime: 0 }));
        job.incoming = { at: stamp(), intent: input.goal, buyer: authorization.from, seller, network: NETWORK, asset: USDC, before, authorization: { ...authorization }, status: "payment_submitted_outcome_pending", http: [] };
        job.status = "accepting_payment";
        await this.save(job); await this.ctx.storage.setAlarm(Date.now() + 120000);
        try {
          job.incoming.settlement = await this.facilitator.settle(payload, requirement);
          await this.save(job);
          if (!job.incoming.settlement.success) throw new Error("Settlement not confirmed; reconciliation required");
          await this.auditIncoming(job);
          job.status = "queued"; delete job.error; await this.save(job); await this.ctx.storage.setAlarm(Date.now() + 1000);
        } catch { job.status = "needs_attention"; job.error = "Incoming payment requires read-only reconciliation; do not pay again"; await this.save(job); await this.ctx.storage.setAlarm(Date.parse(job.expiresAt)); }
        return this.response(job);
      } finally { this.active = false; }
    } catch (error) { return json({ error: "request_failed", message: safeError(error) }, 400); }
  }
  async auditIncoming(job) {
    const record = job.incoming;
    record.response = { requestId: job.requestId, jobId: job.id };
    record.http = [{ paid: true, status: 202, receivedAt: stamp(), headers: { "x-request-id": job.requestId } }];
    await this.audit(record, this.rpc, { expectedAmount: paymentAmount(job.input), allowConcurrentTransfers: true, deliveryStatus: 202, validateDelivery: response => { if (response.jobId !== job.id) throw new Error("Acceptance ID mismatch"); } });
    await this.save(job);
    if (!record.audit?.paymentVerified) throw new Error("Incoming chain audit failed");
  }
  async recoverRecord(record, validateDelivery, expectedAmount = "1000") {
    if (!record.settlement?.success && record.authorization) {
      record.reconciliation = await this.reconcile(record, this.rpc);
      const tx = record.reconciliation.authorizationTransactions;
      if (record.reconciliation.authorizationUsed && tx?.length === 1) record.settlement = { success: true, transaction: tx[0].transactionHash, network: NETWORK, payer: record.buyer };
    }
    if (record.settlement?.success) await this.audit(record, this.rpc, { expectedAmount, allowConcurrentTransfers: true, validateDelivery });
    else if (record.reconciliation?.safeToRetry) record.status = "confirmed_unpaid";
    return record;
  }
  async recover(job) {
    if (job.status === "complete") return;
    if (!job.incoming) return;
    try {
      if (!job.incoming.audit?.paymentVerified) {
        if (!job.incoming.settlement?.success) {
          job.incoming.reconciliation = await this.reconcile(job.incoming, this.rpc);
          const tx = job.incoming.reconciliation.authorizationTransactions;
          if (job.incoming.reconciliation.authorizationUsed && tx?.length === 1) job.incoming.settlement = { success: true, transaction: tx[0].transactionHash, network: NETWORK, payer: job.incoming.buyer };
        }
        if (!job.incoming.settlement?.success) throw new Error("Incoming settlement remains unresolved");
        await this.auditIncoming(job);
      }
      for (const call of job.calls) {
        const record = await this.store.get(`purchase:${call.key}`);
        if (!record) continue;
        if (record.status !== "verified") {
          try { await this.recoverRecord(record, validateCuratorDelivery); }
          finally { await this.store.put(`purchase:${call.key}`, record); }
          if (record.status === "confirmed_unpaid" && !call.retries) { call.retries = 1; await this.store.put(`attempt:${call.key}:0`, record); }
          else if (record.status === "confirmed_unpaid" && call.retries) { call.abandonedUnpaid = true; }
          else if (record.status !== "verified") throw new Error("A purchase remains unresolved or its data response is missing; no automatic repayment");
        }
      }
      if (job.batch?.length) job.batch = job.batch.map(call => job.calls.find(saved => saved.key === call.key)).filter(call => !call.abandonedUnpaid);
      job.status = job.batch?.length ? "buying" : "queued"; delete job.error; delete job.errorTrace; await this.save(job); await this.ctx.storage.setAlarm(Date.now() + 1000);
    } catch (error) {
      const pending = (await this.records(job)).filter(record => record.status !== "verified");
      if (pending.length && pending.every(record => record.authorization && record.reconciliation?.expired === false && record.reconciliation?.authorizationUsed === false)) {
        job.status = "waiting_reconciliation"; job.nextCheckAt = Math.max(Date.now() + 15000, ...pending.map(record => Number(record.authorization.validBefore) * 1000 + 15000));
        delete job.error; await this.save(job); await this.ctx.storage.setAlarm(job.nextCheckAt);
      } else { job.status = "needs_attention"; job.error = safeError(error); await this.save(job); }
    }
  }
  async alarm() {
    if (this.active) { await this.ctx.storage.setAlarm(Date.now() + 60000); return; }
    this.active = true;
    try {
      const job = await this.store.get("job");
      if (!job) return;
      if (Date.now() >= Date.parse(job.expiresAt) || job.status === "awaiting_payment") { await this.ctx.storage.deleteAll(); return; }
      if (terminal.has(job.status)) { await this.ctx.storage.setAlarm(Date.parse(job.expiresAt)); return; }
      // Watchdog survives process loss. Persisted purchase state prevents resubmission.
      await this.ctx.storage.setAlarm(Date.now() + 240000);
      try {
        if (job.status === "accepting_payment") { await this.recover(job); return; }
        await this.step(job);
      } catch (error) { job.status = "needs_attention"; job.error = safeError(error); job.errorTrace = String(error.stack ?? "").split("\n").filter(line => /^\s+at [\w.<> ]+\(?agent-worker\.js:\d+:\d+/.test(line)).slice(0, 5); await this.save(job); }
      await this.ctx.storage.setAlarm(terminal.has(job.status) ? Date.parse(job.expiresAt) : job.status === "waiting_reconciliation" ? job.nextCheckAt : Date.now() + 1000);
    } finally { this.active = false; }
  }
  async step(job) {
    if (!job.incoming?.audit?.paymentVerified) throw new Error("Cannot execute an unpaid or unverified job");
    if (job.status === "waiting_reconciliation") { await this.recover(job); return; }
    const records = await this.records(job);
    if (job.status === "queued" || job.status === "planning") {
      const remaining = Number(job.input.budgetAtomic) / 1000 - job.calls.length;
      if (remaining <= 0 || job.rounds >= MAX_ROUNDS) { job.status = "composing"; await this.save(job); return; }
      if (job.modelCalls >= MAX_ROUNDS + 2) throw new Error("Model request limit reached");
      job.status = "planning"; job.modelCalls++; await this.save(job);
      const plan = await this.plan(this.env, job, records);
      const calls = validateCalls(plan.output, remaining);
      job.modelEvidence.push(plan.evidence); job.rounds++;
      const keys = new Set(job.calls.map(call => call.key));
      job.batch = calls.map(call => { const key = callKey(call); if (keys.has(key)) throw new Error("Agent repeated a purchase; stopped before signing"); keys.add(key); return { ...call, key }; });
      job.calls.push(...job.batch); // Reserve the entire batch before any parallel operation.
      job.status = plan.output.finish ? "composing" : "buying"; await this.save(job); return;
    }
    if (job.status === "buying") {
      const results = await mapLimited(job.batch, CONCURRENCY, async call => {
        let record = await this.store.get(`purchase:${call.key}`);
        if (record && record.status !== "confirmed_unpaid") {
          if (record.status !== "verified") {
            try { await this.recoverRecord(record, validateCuratorDelivery); }
            finally { await this.store.put(`purchase:${call.key}`, record); }
          }
        } else {
          // A start marker closes the crash gap before purchaseDocumentedResource saves preflight.
          await this.store.put(`purchase:${call.key}`, { status: "started", resourceService: call.service, parameters: call.parameters });
          if (record && (!call.retries || !record.reconciliation?.safeToRetry)) throw new Error("Unpaid retry was not authorized by chain reconciliation");
          record = await this.purchase({ service: call.service, parameters: call.parameters, intent: job.input.goal, baseUrl: this.env.CURATOR_SERVER_URL, seller: this.env.UPSTREAM_SELLER_ADDRESS, buyer: privateKeyToAccount(this.env.AGENT_WALLET_KEY), rpc: this.rpc, auditOptions: { allowConcurrentTransfers: true }, save: snapshot => this.store.put(`purchase:${call.key}`, publicEvidence(snapshot)), readResponse: response => readTextBounded(response), redirectPolicy: "manual", fetcher: request => request.headers.has("payment-signature") ? this.env.PAYMENT_CLAIMS.get(this.env.PAYMENT_CLAIMS.idFromName("claims")).fetch("https://internal/outbound", { method: "POST", body: JSON.stringify({ url: request.url, headers: Object.fromEntries(request.headers) }) }) : fetch(request) });
        }
        if (record?.status !== "verified") throw new Error(`Purchase ${call.service} is ${record?.status ?? "unknown"}; no automatic repayment`);
        return record;
      });
      if (results.some(result => result.status === "rejected")) {
        const pending = (await this.records(job)).filter(record => record.status !== "verified");
        if (pending.length && pending.every(record => record.authorization && !record.settlement?.success)) {
          job.status = "waiting_reconciliation"; job.nextCheckAt = Math.max(Date.now() + 15000, ...pending.map(record => Number(record.authorization.validBefore) * 1000 + 15000));
          await this.save(job); return;
        }
        throw new Error(results.filter(result => result.status === "rejected").map(result => result.reason).join("; "));
      }
      job.batch = []; job.status = "queued"; await this.save(job); return;
    }
    if (job.status === "composing") {
      if (job.modelCalls >= MAX_ROUNDS + 2) throw new Error("Model request limit reached");
      job.modelCalls++; await this.save(job);
      const answer = await this.compose(this.env, job, records);
      job.modelEvidence.push(answer.evidence);
      const priorAttempts = (await Promise.all(job.calls.filter(call => call.retries).map(call => this.store.get(`attempt:${call.key}:0`)))).filter(Boolean);
      const delivery = { goal: job.input.goal, reportMarkdown: answer.report, reportSha256: sha256(answer.report), purchases: records, priorAttempts, modelEvidence: job.modelEvidence, completedAt: stamp(), totalUpstreamAtomic: String(records.filter(record => record.status === "verified").length * 1000) };
      await this.store.put("delivery", delivery); job.status = "complete"; await this.save(job); return;
    }
    throw new Error("Unknown durable job state");
  }
}

// External service error bodies/URLs may contain credentials. Persist only controlled messages.
function safeError(error) {
  const text = String(error?.message ?? "Operation failed");
  if (/https?:|Bearer |sk-|0x[0-9a-f]{64}/i.test(text)) return "External operation failed; inspect redacted diagnostics and payment state";
  return text.slice(0, 600);
}
