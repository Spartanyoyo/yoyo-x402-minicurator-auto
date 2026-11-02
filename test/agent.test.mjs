import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { JsonStore, taskInput, taskIdentity, sha256, validateCalls, callKey, mapLimited, readTextBounded } from "../src/agent-contract.mjs";
import { CloudCuratorJob, PaymentClaims, validIngress, ingressRequirement } from "../src/agent-job.mjs";
import { modelJson, renderReport, detailedWorks } from "../src/agent-model.mjs";
import { auditPurchase } from "../scripts/chain.mjs";
import { purchaseCurator } from "../scripts/curator-purchase.mjs";
import { publicEvidence } from "../src/agent-evidence.mjs";
import { reconcilePurchase } from "../scripts/reconcile.mjs";
import { resource } from "./curator-fixtures.mjs";
import { fakeRpc, purchaseRecord, signer, seller, transaction } from "./fixtures.mjs";

class Storage {
  map = new Map(); alarm = null; pending = Promise.resolve();
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async deleteAll() { this.map.clear(); this.alarm = null; }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async list() { return new Map(this.map); }
  transaction(fn) { const operation = this.pending.then(() => fn(this)); this.pending = operation.catch(() => {}); return operation; }
}
const token = "a".repeat(64);
const input = { goal: "给孩子制作三馆猫主题迷你展览", budgetAtomic: "3000" };
const id = taskIdentity(input, token);
const url = `https://agent.test/jobs/${id}`;
const key = `0x${"11".repeat(32)}`;
const payer = privateKeyToAccount(`0x${"22".repeat(32)}`);
const env = { AGENT_WALLET_KEY: key, CURATOR_SERVER_URL: "https://museum.test", UPSTREAM_SELLER_ADDRESS: seller };
const calls = ["met-artwork", "cma-artwork", "smk-artwork"].map(service => ({ service, parameters: resource(service).query }));
const records = () => calls.map(call => ({ resourceService: call.service, parameters: call.parameters, status: "verified", response: { resource: resource(call.service) }, settlement: { transaction } }));
function payload() {
  const accepted = ingressRequirement(signer.address, "6000");
  return { x402Version: 2, resource: { url }, accepted, payload: { signature: "0xabc", authorization: { from: payer.address, to: signer.address, value: "6000", nonce: `0x${"ab".repeat(32)}`, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 250) } } };
}
function setup(options = {}) {
  const storage = new Storage(); const state = { storage };
  const claims = new PaymentClaims({ storage: new Storage() });
  let paid = 0; let settled = 0; let active = 0; let peak = 0;
  const dependencies = {
    rpc: fakeRpc().rpc,
    facilitator: { verify: async () => ({ isValid: true }), settle: async () => { settled++; if (options.settleError) throw new Error("lost settlement response"); return { success: true, transaction, network: "eip155:84532", payer: payer.address }; } },
    audit: async record => { record.audit = { paymentVerified: true }; record.status = "verified"; },
    reconcile: async () => ({ authorizationUsed: false, safeToRetry: false }),
    plan: async () => ({ output: { finish: false, calls }, evidence: { model: "fixture" } }),
    compose: async () => ({ report: "verified fixture report", evidence: { model: "fixture" } }),
    purchase: async purchase => {
      paid++; active++; peak = Math.max(peak, active);
      assert.equal((await new JsonStore(storage).get("job")).calls.length, 3, "reserve all calls before external I/O");
      await new Promise(resolve => setTimeout(resolve, 2));
      const record = records().find(r => r.resourceService === purchase.service);
      if (options.lostPurchase === purchase.service) record.status = "outcome_unknown_check_chain_before_retry";
      await purchase.save(record); active--; return record;
    },
    ...options.dependencies,
  };
  const boundEnv = { ...env, PAYMENT_CLAIMS: { idFromName: value => value, get: () => ({ fetch: (u, init) => claims.fetch(new Request(u, init)) }) } };
  const instance = new CloudCuratorJob(state, boundEnv, dependencies);
  return { instance, storage, state, dependencies, env: boundEnv, stats: () => ({ paid, settled, peak }) };
}
const req = (method = "POST", payment, bearer = token, body = input, suffix = "") => new Request(`${url}${suffix}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(payment ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) } : {}) }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });

test("task identity binds normalized goal, budget and recovery token", () => {
  assert.equal(taskIdentity({ ...input, goal: ` ${input.goal} ` }, token), id);
  assert.notEqual(taskIdentity({ ...input, budgetAtomic: "4000" }, token), id);
  assert.notEqual(taskIdentity(input, "b".repeat(64)), id);
  for (const bad of [{ ...input, budgetAtomic: "10000" }, { ...input, budgetAtomic: "1000" }, { ...input, budgetAtomic: "2000" }, { ...input, host: "evil" }, { goal: "hi" }, { ...input, budgetAtomic: 3000 }]) assert.throws(() => taskInput(bad));
});
test("tool gate rejects external tools, malformed parameters, excess calls and no progress", () => {
  for (const plan of [{ finish: false, calls: [] }, { finish: true, calls }, { finish: false, calls: [...calls, calls[0]] }, { finish: false, calls: [{ service: "fetch", parameters: {} }] }, { finish: false, calls: [{ service: "met-artwork", parameters: { id: "0" } }] }]) assert.throws(() => validateCalls(plan, 3));
  assert.throws(() => validateCalls({ finish: false, calls }, 2));
  assert.equal(validateCalls({ finish: false, calls }, 3).length, 3);
});
test("bounded reader stops streams without Content-Length", async () => {
  await assert.rejects(readTextBounded(new Response("12345"), 4), /limit/);
  assert.equal(await readTextBounded(new Response("1234"), 4), "1234");
});
test("chunked storage round trips Unicode and detects corruption", async () => {
  const storage = new Storage(); const store = new JsonStore(storage); const object = { text: "博物馆".repeat(30000) };
  await store.put("record", object); assert.deepEqual(await store.get("record"), object);
  assert.ok(storage.map.size > 2);
  await storage.put("record:0", "corrupt"); await assert.rejects(store.get("record"), /hash/);
  await assert.rejects(store.put("large", { text: "a".repeat(3 * 1024 * 1024) }), /2 MiB/);
});
test("bounded parallel execution waits for every in-flight outcome", async () => {
  let active = 0; let peak = 0; let finished = 0;
  const output = await mapLimited([1, 2, 3, 4, 5], 3, async value => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; finished++; if (value === 2) throw new Error("unknown"); return value; });
  assert.equal(peak, 3); assert.equal(finished, 5); assert.equal(output[1].status, "rejected");
});
test("cross-job replay claims are atomic and same-job claims idempotent", async () => {
  const claims = new PaymentClaims({ storage: new Storage() }); const auth = payload().payload.authorization;
  const claim = jobId => claims.fetch(new Request("https://internal/claim", { method: "POST", body: JSON.stringify({ payer: auth.from, nonce: auth.nonce, validBefore: auth.validBefore, jobId }) }));
  const result = await Promise.all([claim(id), claim("b".repeat(64))]);
  assert.deepEqual(result.map(r => r.status), [200, 409]); assert.equal((await claim(id)).status, 200);
});
for (const [label, alter] of [
  ["wrong resource", p => { p.resource.url += "x"; }], ["mainnet", p => { p.accepted.network = "eip155:8453"; }],
  ["wrong amount", p => { p.payload.authorization.value = "1000"; }], ["wrong recipient", p => { p.payload.authorization.to = seller; }],
  ["expired authorization", p => { p.payload.authorization.validBefore = "1"; }], ["excessive validity", p => { p.payload.authorization.validBefore = "9999999999"; }],
  ["upfront flow", p => { p.accepted.extra.paymentFlow = "upfront"; }],
]) test(`ingress rejects ${label}`, () => { const p = payload(); alter(p); assert.equal(Boolean(validIngress(p, ingressRequirement(signer.address, "6000"), url)), false); });
test("unpaid draft quotes 402 and cannot execute purchases", async () => {
  const { instance, stats } = setup(); const response = await instance.fetch(req());
  assert.equal(response.status, 402); assert.ok(response.headers.get("payment-required")); assert.equal(stats().paid, 0);
  assert.equal((await instance.fetch(req("GET", null, "b".repeat(64)))).status, 401);
});
test("goal mutation under an existing identifier is rejected before payment", async () => {
  const { instance, stats } = setup(); assert.equal((await instance.fetch(req("POST", payload(), token, { ...input, goal: "another goal" }))).status, 409); assert.equal(stats().settled, 0);
});
test("durable job pays once, reserves budget, buys in parallel and redelivers without payment", async () => {
  const { instance, stats } = setup();
  assert.equal((await instance.fetch(req("POST", payload()))).status, 202);
  await instance.fetch(req("POST", payload())); assert.equal(stats().settled, 1);
  for (let i = 0; i < 4; i++) await instance.alarm();
  const result = await (await instance.fetch(req("GET"))).json();
  assert.equal(result.status, "complete"); assert.equal(result.delivery.purchases.length, 3); assert.equal(stats().peak, 3); assert.equal(stats().paid, 3);
  const again = await (await instance.fetch(req("GET"))).json(); assert.equal(again.delivery.reportSha256, sha256("verified fixture report"));
  assert.equal(stats().settled, 1); assert.equal(JSON.stringify(result).includes(token), false);
});
test("lost incoming settlement response never repeats settlement", async () => {
  const { instance, stats } = setup({ settleError: true });
  const first = await (await instance.fetch(req("POST", payload()))).json(); assert.equal(first.status, "needs_attention");
  await instance.fetch(req("POST", payload())); await instance.fetch(req("POST", null, token, {}, "/reconcile"));
  assert.equal(stats().settled, 1); assert.equal(stats().paid, 0);
});
test("lost downstream response survives restart and does not repay or compose", async () => {
  const fixture = setup({ lostPurchase: "met-artwork" }); const { instance, stats } = fixture;
  await instance.fetch(req("POST", payload())); await instance.alarm(); await instance.alarm();
  const restarted = new CloudCuratorJob(fixture.state, fixture.env, fixture.dependencies);
  await restarted.fetch(req("POST", null, token, {}, "/reconcile")); await restarted.alarm();
  const result = await (await restarted.fetch(req("GET"))).json();
  assert.equal(result.status, "needs_attention"); assert.equal(stats().paid, 3); assert.equal(result.delivery, undefined);
});
test("duplicate calls from model are stopped before any duplicate purchase", async () => {
  const fixture = setup(); await fixture.instance.fetch(req("POST", payload()));
  const job = await fixture.instance.store.get("job"); job.input.budgetAtomic = "9000"; await fixture.instance.save(job);
  await fixture.instance.alarm(); await fixture.instance.alarm(); await fixture.instance.alarm();
  const result = await fixture.instance.store.get("job"); assert.equal(result.status, "needs_attention"); assert.equal(fixture.stats().paid, 3); assert.equal(result.calls.length, 3);
});
test("expired jobs delete all persisted payloads and reports", async () => {
  const { instance, storage } = setup(); await instance.fetch(req());
  const job = await instance.store.get("job"); job.expiresAt = new Date(Date.now() - 1).toISOString(); await instance.save(job);
  assert.equal((await instance.fetch(req("GET"))).status, 410); await instance.alarm(); assert.equal(storage.map.size, 0);
});
test("model API errors do not expose its response body or key", async () => {
  await assert.rejects(modelJson({ AGENT_LLM_BASE_URL: "https://api.test", AGENT_LLM_MODEL: "fixture", AGENT_LLM_API_KEY: "secret" }, [], async () => new Response("private upstream error", { status: 401 })), error => error.message === "Model API HTTP 401");
});
test("truncated model JSON is never accepted as a valid plan", async () => {
  await assert.rejects(modelJson({ AGENT_LLM_BASE_URL: "https://api.test", AGENT_LLM_MODEL: "fixture", AGENT_LLM_API_KEY: "secret" }, [], async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] })), /incomplete/);
});
test("report citations and images come exclusively from verified purchases", () => {
  const rs = records(); const works = detailedWorks(rs);
  const report = { title: "三馆猫", introduction: "观察猫的不同形象。", stops: works.map(work => ({ key: work.key, minutes: 5, commentary: "这是一个观察活动。", question: "你看到了什么？" })), conclusion: "对比三件作品。" };
  const result = renderReport(report, works, { id, input }, rs); assert.ok(result.includes(works[0].sourceUrl)); assert.ok(result.includes(works[0].imageUrl));
  report.stops[0].key = "Met:invented"; assert.throws(() => renderReport(report, works, { id, input }, rs), /citation/);
});
test("parallel chain audit explains all transfers while retaining nonce and exact-transaction checks", async () => {
  const extra = { transactionHash: `0x${"cd".repeat(32)}`, blockNumber: 101n, logIndex: 1, args: { from: signer.address, to: seller, value: 1000n } };
  const { rpc } = fakeRpc({ extraTransfers: [extra] });
  rpc.readContract = async ({ args: [address], blockNumber }) => address.toLowerCase() === signer.address.toLowerCase() ? blockNumber > 100n ? 8000n : 10000n : blockNumber > 100n ? 2000n : 0n;
  const record = purchaseRecord(); await auditPurchase(record, rpc, { allowConcurrentTransfers: true });
  assert.equal(record.status, "verified"); assert.equal(record.audit.noOtherTransfers, false); assert.equal(record.audit.balanceChangesExplained, true);
  await auditPurchase(record, rpc); assert.equal(record.status, "audit_failed", "Phase 2-A retains strict isolated-transfer behavior");
  record.authorization.nonce = `0x${"ff".repeat(32)}`; await auditPurchase(record, rpc, { allowConcurrentTransfers: true }); assert.equal(record.status, "audit_failed");
});
test("parallel audit rejects unexplained balances or missing own transfer", async () => {
  const { rpc } = fakeRpc(); const original = rpc.readContract;
  rpc.readContract = async options => await original(options) + (options.blockNumber > 100n ? 1n : 0n);
  const record = purchaseRecord(); await auditPurchase(record, rpc, { allowConcurrentTransfers: true }); assert.equal(record.status, "audit_failed");
  rpc.readContract = original; rpc.getLogs = async () => []; await auditPurchase(record, rpc, { allowConcurrentTransfers: true }); assert.equal(record.status, "audit_failed");
});
test("async persistence failure prevents even the first network operation", async () => {
  let network = 0;
  await assert.rejects(purchaseCurator({ service: "met-artwork", parameters: calls[0].parameters, intent: "test museum", seller, buyer: signer, save: async () => { throw new Error("storage unavailable"); }, fetcher: async () => { network++; } }), /storage unavailable/);
  assert.equal(network, 0);
});
test("facilitator payment lane serializes paid submissions across jobs", async () => {
  let active = 0; let peak = 0; let submissions = 0;
  const gate = new PaymentClaims({ storage: new Storage() }, env, { fetcher: async () => { submissions++; active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return Response.json({ ok: true }); } });
  const outbound = () => gate.fetch(new Request("https://internal/outbound", { method: "POST", body: JSON.stringify({ url: "https://museum.test/api/met-artwork?id=552027", headers: { "payment-signature": encodePaymentSignatureHeader(payload()) } }) }));
  const results = await Promise.all([outbound(), outbound(), outbound()]);
  assert.equal(submissions, 3); assert.equal(peak, 1); assert.ok(results.every(r => r.ok));
});
test("payment lane crash lease prevents another ambiguous submission", async () => {
  const storage = new Storage(); await storage.put("outbound-lease", { expires: Date.now() + 60000 });
  let calls = 0; const gate = new PaymentClaims({ storage }, env, { fetcher: async () => { calls++; } });
  const response = await gate.fetch(new Request("https://internal/outbound", { method: "POST", body: JSON.stringify({ url: "https://museum.test/api/met-artwork?id=552027", headers: { "payment-signature": encodePaymentSignatureHeader(payload()) } }) }));
  assert.equal(response.status, 503); assert.equal(calls, 0);
});
test("public evidence removes replayable signatures, raw transactions and bearer tokens", () => {
  const value = publicEvidence({ token, tokenHash: "hash", authorization: { nonce: `0x${"aa".repeat(32)}`, signature: "secret" }, headers: { "PAYMENT-RESPONSE": "encoded raw payload" }, settlement: { errorMessage: `eth_sendRawTransaction 0x${"ab".repeat(300)} replacement transaction underpriced` } });
  assert.equal(value.token, undefined); assert.equal(value.tokenHash, undefined); assert.equal(value.authorization.signature, undefined); assert.equal(value.headers["PAYMENT-RESPONSE"], undefined);
  assert.ok(value.authorization.nonce); assert.equal(value.settlement.errorMessage, "Facilitator relayer nonce conflict; signed diagnostics redacted");
});
test("a provably unpaid expired attempt can be retried once with history retained", async () => {
  const f = setup(); await f.instance.fetch(req("POST", payload())); await f.instance.alarm();
  const job = await f.instance.store.get("job"); const call = job.calls[0];
  await f.instance.store.put(`purchase:${call.key}`, { resourceService: call.service, status: "outcome_unknown_check_chain_before_retry", authorization: payload().payload.authorization });
  f.instance.reconcile = async () => ({ safeToRetry: true, expired: true, authorizationUsed: false, balanceChangesExplained: true });
  job.status = "needs_attention"; await f.instance.save(job);
  await f.instance.fetch(req("POST", null, token, {}, "/reconcile"));
  const recovered = await f.instance.store.get("job"); assert.equal(recovered.batch[0].retries, 1);
  assert.equal((await f.instance.store.get(`attempt:${call.key}:0`)).status, "confirmed_unpaid");
  await f.instance.alarm(); assert.equal(f.stats().paid, 3);
});
test("shared-wallet retry proof uses the exact expired unused nonce despite other transfers", async () => {
  const record = purchaseRecord(); record.authorization.validBefore = "900";
  const { rpc } = fakeRpc(); const balances = rpc.readContract;
  rpc.getBlockNumber = async () => 200n;
  rpc.readContract = async options => options.functionName === "authorizationState" ? false : balances(options);
  const result = await reconcilePurchase(record, rpc, { allowConcurrentTransfers: true, maxBlocks: 1 });
  assert.equal(result.safeToRetry, true); assert.equal(result.authorizationUsed, false); assert.equal(result.after.buyer, "9000"); assert.equal(result.verificationBasis, "expired_plus_12_seconds_and_exact_contract_nonce_unused");
  record.before.buyer = "11000"; assert.equal((await reconcilePurchase(record, rpc, { allowConcurrentTransfers: true })).safeToRetry, false);
});
test("unexpired ambiguous payment schedules reconciliation without a new purchase", async () => {
  const f = setup(); await f.instance.fetch(req("POST", payload())); await f.instance.alarm();
  const job = await f.instance.store.get("job"); const call = job.calls[0];
  await f.instance.store.put(`purchase:${call.key}`, { resourceService: call.service, status: "outcome_unknown_check_chain_before_retry", authorization: payload().payload.authorization });
  f.instance.reconcile = async () => ({ safeToRetry: false, expired: false, authorizationUsed: false });
  job.status = "needs_attention"; await f.instance.save(job); await f.instance.fetch(req("POST", null, token, {}, "/reconcile"));
  const waiting = await f.instance.store.get("job"); assert.equal(waiting.status, "waiting_reconciliation"); assert.ok(waiting.nextCheckAt > Date.now()); assert.equal(f.stats().paid, 0);
});
test("global incoming quota bounds operator-funded model work", async () => {
  const claims = new PaymentClaims({ storage: new Storage() }); const authorization = payload().payload.authorization;
  for (let i = 0; i < 11; i++) {
    const response = await claims.fetch(new Request("https://internal/claim", { method: "POST", body: JSON.stringify({ payer: authorization.from, nonce: `0x${i.toString(16).padStart(64, "0")}`, jobId: i.toString(16).padStart(64, "0"), validBefore: authorization.validBefore }) }));
    assert.equal(response.status, i < 10 ? 200 : 409);
  }
});
test("report route deterministically matches an explicit requested duration", () => {
  const rs = records(); const works = detailedWorks(rs);
  const output = { title: "三馆观察", introduction: "一起看猫。", stops: works.map(work => ({ key: work.key, minutes: 4, commentary: "观察作品。", question: "你看见了什么？" })), conclusion: "交流观察。" };
  const report = renderReport(output, works, { id, input: { ...input, goal: "做一个15分钟猫主题展览" } }, rs);
  const durations = [...report.matchAll(/（(\d+) 分钟）/g)].map(match => Number(match[1]));
  assert.deepEqual(durations, [5, 5, 5]); assert.ok(report.includes("路线总时长：15 分钟"));
});
test("oversized model input is rejected before any billable API call", async () => {
  let requests = 0;
  await assert.rejects(modelJson({ AGENT_LLM_BASE_URL: "https://api.test", AGENT_LLM_MODEL: "fixture", AGENT_LLM_API_KEY: "secret" }, [{ role: "user", content: "a".repeat(130 * 1024) }], async () => { requests++; }), /128 KiB/);
  assert.equal(requests, 0);
});
