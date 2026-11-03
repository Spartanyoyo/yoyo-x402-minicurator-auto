import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { CloudCuratorJob, PaymentClaims, ingressRequirement } from "../src/agent-job.mjs";
import { curationInput, curationIdentity, JsonStore, sha256, callKey, RPC_LIMIT } from "../src/agent-contract.mjs";
import { directTool, continuationCalls } from "../src/agent-tools.mjs";
import { workerRpc, incrementalAudit, RpcYield, reconcilePayment } from "../src/agent-payment.mjs";
import { publicEvidence } from "../src/agent-evidence.mjs";
import { renderReport, detailedWorks } from "../src/agent-model.mjs";
import { resource, raw } from "./curator-fixtures.mjs";
import { fakeRpc, purchaseRecord, transaction } from "./fixtures.mjs";
import { getCloudJob, submitCloudJob, payCloudJob } from "../scripts/agent-client.mjs";

class Storage {
  map = new Map(); pending = Promise.resolve(); alarm = null;
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async deleteAll() { this.map.clear(); this.alarm = null; }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async list() { return new Map(this.map); }
  transaction(fn) { const result = this.pending.then(() => fn(this)); this.pending = result.catch(() => {}); return result; }
}
const token = "a".repeat(64);
const input = curationInput({ goal: "为小朋友制作15分钟三馆猫主题展览" });
const id = curationIdentity(input, token);
const url = `https://agent.test/jobs/${id}`;
const sellerKey = `0x${"11".repeat(32)}`;
const seller = privateKeyToAccount(sellerKey).address;
const buyer = privateKeyToAccount(`0x${"22".repeat(32)}`);
const calls = ["met-artwork", "cma-artwork", "smk-artwork"].map(service => ({ service, parameters: resource(service).query }));
const records = () => calls.map(call => ({ resourceService: call.service, parameters: call.parameters, status: "ok", access: "direct_free_api", upstreamPaymentAtomic: "0", response: { resource: resource(call.service) }, resourceSha256: sha256(call.service) }));
const request = (method = "POST", suffix = "", payment, body = input, bearer = token) => new Request(url + suffix, { method, headers: { Authorization: `Bearer ${bearer}`, ...(payment ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) } : {}) }, ...(method === "POST" && !suffix ? { body: JSON.stringify(body) } : {}) });
function payload() { return { x402Version: 2, resource: { url: url + "/delivery" }, accepted: ingressRequirement(seller, "3000"), payload: { signature: "0xabc", authorization: { from: buyer.address, to: seller, value: "3000", nonce: `0x${"ac".repeat(32)}`, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 250) } } }; }
function setup(overrides = {}) {
  const storage = new Storage(); const claims = new PaymentClaims({ storage: new Storage() });
  const env = { AGENT_WALLET_KEY: sellerKey, PAYMENT_CLAIMS: { idFromName: v => v, get: () => ({ fetch: (u, init) => claims.fetch(new Request(u, init)) }) } };
  const stats = { tools: [], settled: 0, audits: 0, active: 0, peak: 0, plans: 0, composed: 0 };
  const dependencies = {
    rpcFactory: () => fakeRpc().rpc,
    facilitator: { verify: async () => ({ isValid: true }), settle: async () => { stats.settled++; return { success: true, transaction, network: "eip155:84532", payer: buyer.address }; } },
    auditPayment: async record => { stats.audits++; record.audit = { paymentVerified: true }; record.status = "verified"; },
    plan: async () => { stats.plans++; return { output: { finish: false, calls }, evidence: { model: "fixture" } }; },
    compose: async () => { stats.composed++; return { report: "完整的三馆展览成品", evidence: { model: "fixture" } }; },
    tool: async call => { stats.tools.push(call.service); stats.active++; stats.peak = Math.max(stats.peak, stats.active); await new Promise(resolve => setTimeout(resolve, 2)); stats.active--; return records().find(record => record.resourceService === call.service); },
    ...overrides,
  };
  return { instance: new CloudCuratorJob({ storage }, env, dependencies), storage, env, stats, dependencies };
}
async function prepare(fixture) { assert.equal((await fixture.instance.fetch(request())).status, 202); for (let i = 0; i < 4; i++) await fixture.instance.alarm(); return (await fixture.instance.fetch(request("GET"))).json(); }
async function accept(fixture) { assert.equal((await fixture.instance.fetch(request("POST", "/delivery", payload()))).status, 202); await fixture.instance.alarm(); }

test("v2 identity binds goal, call cap and token; rejects monetary procurement budgets", () => {
  assert.equal(curationIdentity({ goal: ` ${input.goal} ` }, token), id);
  assert.notEqual(curationIdentity({ ...input, maxCalls: 12 }, token), id);
  for (const value of [{ ...input, maxCalls: 31 }, { ...input, budgetAtomic: "9000" }, { ...input, protocolVersion: 1 }, { ...input, host: "evil" }]) assert.throws(() => curationInput(value));
});
test("prepare first, then quote; unpaid result body and resources never leak", async () => {
  const f = setup(); const before = await f.instance.fetch(request()); assert.equal(before.status, 202);
  assert.equal((await f.instance.fetch(request("POST", "/delivery", payload()))).status, 409);
  for (let i = 0; i < 4; i++) await f.instance.alarm();
  const ready = await (await f.instance.fetch(request("GET"))).json();
  assert.equal(ready.status, "ready"); assert.equal(ready.delivery, undefined); assert.equal(ready.incoming, undefined); assert.equal(f.stats.settled, 0); assert.equal(f.stats.peak, 3);
  const quoteResponse = await f.instance.fetch(request("POST", "/delivery"));
  const quote = decodePaymentRequiredHeader(quoteResponse.headers.get("payment-required"));
  assert.equal(quoteResponse.status, 402); assert.equal(quote.accepts[0].amount, "3000"); assert.ok(quote.resource.description.includes(ready.summary.reportSha256)); assert.equal((await quoteResponse.text()).includes("完整的三馆展览成品"), false);
});
test("payment settlement and audit run in separate alarms, redelivery never repays", async () => {
  const f = setup(); await prepare(f); await accept(f);
  assert.equal(f.stats.settled, 0); await f.instance.alarm(); assert.equal(f.stats.settled, 1); assert.equal(f.stats.audits, 0);
  assert.equal((await (await f.instance.fetch(request("GET"))).json()).delivery, undefined);
  await f.instance.alarm(); const first = await (await f.instance.fetch(request("GET"))).json();
  assert.equal(first.status, "complete"); assert.equal(first.delivery.totalUpstreamAtomic, "0"); assert.deepEqual(first.delivery.purchases, []);
  await f.instance.fetch(request("POST", "/delivery", payload())); const second = await (await f.instance.fetch(request("GET"))).json();
  assert.deepEqual(first, second); assert.equal(f.stats.settled, 1); assert.equal(f.stats.composed, 1);
});
test("goal mutation and wrong bearer fail without starting model or payment", async () => {
  const f = setup(); assert.equal((await f.instance.fetch(request("POST", "", null, { ...input, goal: "另一个不同主题展览" }))).status, 409);
  await f.instance.fetch(request()); assert.equal((await f.instance.fetch(request("GET", "", null, input, "b".repeat(64)))).status, 401); assert.equal(f.stats.plans, 0); assert.equal(f.stats.settled, 0);
});
test("transient Block at number could not be found automatically resumes audit without manual reconcile", async () => {
  let audits = 0; const f = setup({ auditPayment: async record => { if (++audits === 1) throw new Error('Block at number "53655608" could not be found'); record.audit = { paymentVerified: true }; record.status = "verified"; } });
  await prepare(f); await accept(f); await f.instance.alarm(); await f.instance.alarm();
  assert.equal((await f.instance.store.get("job")).status, "auditing_payment"); assert.equal((await f.instance.store.get("job")).retry.attempts, 1);
  await f.instance.alarm(); assert.equal((await f.instance.store.get("job")).status, "complete"); assert.equal(f.stats.settled, 1);
});
test("accepted payment survives a transient pre-settlement balance RPC failure and restart", async () => {
  let reads = 0;
  const f = setup({ rpcFactory: () => ({ ...fakeRpc().rpc, getBlockNumber: async () => { if (++reads === 1) throw new Error('Block at number "53655608" could not be found'); return 100n; } }) });
  await prepare(f);
  const accepted = await f.instance.fetch(request("POST", "/delivery", payload()));
  assert.equal(accepted.status, 202); assert.equal(reads, 0); assert.equal((await accepted.json()).status, "preparing_payment");
  await f.instance.alarm();
  assert.equal((await f.instance.store.get("job")).status, "preparing_payment"); assert.equal((await f.instance.store.get("job")).retry.attempts, 1); assert.equal(f.stats.settled, 0);
  const restarted = new CloudCuratorJob({ storage: f.storage }, f.env, f.dependencies);
  await restarted.alarm(); assert.equal((await restarted.store.get("job")).status, "settling_payment");
  await restarted.alarm(); await restarted.alarm();
  assert.equal((await restarted.store.get("job")).status, "complete"); assert.equal(f.stats.settled, 1);
});
test("reconcile before first settlement preserves accepted payment preparation instead of waiting for expiry", async () => {
  const f = setup(); await prepare(f); await f.instance.fetch(request("POST", "/delivery", payload()));
  const first = await (await f.instance.fetch(request("POST", "/reconcile"))).json();
  assert.equal(first.status, "preparing_payment"); assert.equal(f.stats.settled, 0);
  await f.instance.alarm();
  const second = await (await f.instance.fetch(request("POST", "/reconcile"))).json();
  assert.equal(second.status, "settling_payment"); assert.equal(f.stats.settled, 0);
  await f.instance.alarm(); await f.instance.alarm();
  assert.equal((await f.instance.store.get("job")).status, "complete"); assert.equal(f.stats.settled, 1);
});
test("a lost settlement response and restart never submit the authorization twice", async () => {
  let settles = 0;
  const f = setup({ facilitator: { verify: async () => ({ isValid: true }), settle: async () => { settles++; throw new Error("connection lost"); } }, reconcilePayment: async record => { record.settlement = { success: true, transaction, network: "eip155:84532", payer: buyer.address }; return "settled"; } });
  await prepare(f); await accept(f); await f.instance.alarm();
  const restarted = new CloudCuratorJob({ storage: f.storage }, f.env, f.dependencies); await restarted.alarm(); await restarted.alarm();
  assert.equal((await restarted.store.get("job")).status, "complete"); assert.equal(settles, 1);
});
test("unknown or unused unexpired payments remain read-only and do not expose delivery", async () => {
  const f = setup({ facilitator: { verify: async () => ({ isValid: true }), settle: async () => { f.stats.settled++; throw new Error("lost"); } }, reconcilePayment: async () => "waiting" });
  await prepare(f); await accept(f); await f.instance.alarm();
  for (let i = 0; i < 3; i++) await f.instance.alarm();
  const result = await (await f.instance.fetch(request("GET"))).json(); assert.equal(result.status, "reconciling_payment"); assert.equal(result.delivery, undefined); assert.equal(f.stats.settled, 1);
});
test("definitively unavailable artwork selects another ID without any reconciliation or repayment", async () => {
  const f = setup(); const search = resource("met-search"); search.items = [{ id: "497126", rightsVerified: false }, { id: "552027", rightsVerified: false }]; search.returned = 2;
  const job = { ...input, calls: [], input, rounds: 0 };
  const first = continuationCalls(job, [{ resourceService: "met-search", status: "ok", response: { resource: search } }], 5);
  assert.equal(first[0].parameters.id, 497126);
  job.calls.push({ ...first[0], key: callKey(first[0]) });
  const next = continuationCalls(job, [{ resourceService: "met-search", status: "ok", response: { resource: search } }, { resourceService: "met-artwork", parameters: { id: 497126 }, status: "unavailable", httpStatus: 422 }], 4);
  assert.equal(next[0].parameters.id, 552027); assert.equal(f.stats.settled, 0);
});
test("SMK total=583 returned=0 excluded=5 deterministically advances offset", () => {
  const page = resource("smk-search"); page.query = { q: "birds", limit: 5, offset: 0 }; page.total = 583; page.returned = 0; page.excluded = 5; page.items = [];
  const first = { service: "smk-search", parameters: page.query };
  const next = continuationCalls({ calls: [{ ...first, key: callKey(first) }] }, [{ resourceService: "smk-search", status: "ok", response: { resource: page } }], 3);
  assert.deepEqual(next, [{ service: "smk-search", parameters: { q: "birds", limit: 5, offset: 5 } }]);
});
test("early model finish with missing museum is rejected and planning continues", async () => {
  let attempts = 0; const f = setup({ plan: async () => ({ output: ++attempts === 1 ? { finish: true, calls: [] } : { finish: false, calls }, evidence: {} }) });
  await f.instance.fetch(request()); await f.instance.alarm(); assert.equal((await f.instance.store.get("job")).status, "queued");
  for (let i = 0; i < 4; i++) await f.instance.alarm();
  assert.equal((await f.instance.store.get("job")).status, "ready"); assert.equal(f.stats.settled, 0);
});
test("blocked free artwork is classified unavailable, never sent through an x402 wrapper", async () => {
  const item = raw("met-artwork"); item.isPublicDomain = false; const urls = [];
  const output = await directTool(calls[0], { fetcher: async (url, init) => { urls.push(url); assert.equal(new Headers(init.headers).has("payment-signature"), false); return Response.json(item); } });
  assert.equal(output.status, "unavailable"); assert.equal(output.httpStatus, 422); assert.equal(output.upstreamPaymentAtomic, "0"); assert.ok(urls[0].startsWith("https://collectionapi.metmuseum.org/"));
});
test("SMK official API thumbnail URLs are accepted, rights filtering is requested and one malformed item does not discard a search page", async () => {
  const body = raw("smk-search"); const good = structuredClone(body.items.find(item => item.public_domain && item.image_thumbnail));
  good.image_thumbnail = "https://api.smk.dk/api/v1/thumbnail/c94da9b4-f459-4ccf-a614-77d79bdee5f2.jpg";
  const bad = structuredClone(good); bad.image_thumbnail = "https://evil.test/injected.jpg";
  body.items = [bad, good]; body.found = 583;
  const output = await directTool({ service: "smk-search", parameters: { q: "bird", limit: 10, offset: 0 } }, { fetcher: async url => { assert.equal(new URL(url).searchParams.get("filters"), "[public_domain:true]"); return Response.json(body); } });
  assert.equal(output.status, "ok"); assert.equal(output.response.resource.returned, 1); assert.equal(output.response.resource.excluded, 1); assert.equal(output.response.resource.total, 583);
  assert.ok(output.response.resource.items[0].imageUrl.startsWith("https://api.smk.dk/api/v1/thumbnail/"));
});
test("free GET transient failure retries at most three times, then leaves planning to find an alternative", async () => {
  const f = setup({ tool: async call => ({ resourceService: call.service, parameters: call.parameters, status: "retryable", error: "HTTP 503" }) });
  await f.instance.fetch(request()); await f.instance.alarm(); for (let i = 0; i < 3; i++) await f.instance.alarm();
  const job = await f.instance.store.get("job"); assert.equal(job.status, "queued"); assert.ok(job.calls.every(call => call.attempts === 3 && call.state === "failed")); assert.equal(f.stats.settled, 0);
});
test("free preparation quotas are atomic and repeat creation is idempotent", async () => {
  const claims = new PaymentClaims({ storage: new Storage() }); const prepare = i => claims.fetch(new Request("https://internal/prepare", { method: "POST", body: JSON.stringify({ jobId: i.toString(16).padStart(64, "0"), ipHash: "a".repeat(64) }) }));
  const results = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(prepare)); assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200, 200, 429]); assert.equal((await prepare(0)).status, 200);
});
test("worker RPC caps actual HTTP subrequests including retries and switches lagging nodes", async () => {
  let requests = 0; const endpoints = []; const state = {};
  const rpc = workerRpc({ BASE_SEPOLIA_RPCS: "https://one.test,https://two.test" }, state, async (url, init) => { requests++; endpoints.push(url); const body = JSON.parse(init.body); if (requests === 1) return Response.json({ error: { message: "Block not found" } }); return Response.json({ result: body.method === "eth_chainId" ? "0x14a34" : "0x64" }); });
  assert.equal(await rpc.getChainId(), 84532); assert.notEqual(endpoints[0], endpoints[1]);
  for (let i = 0; i < RPC_LIMIT - 2; i++) await rpc.getBlockNumber({ cacheTime: 0 });
  await assert.rejects(rpc.getBlockNumber({ cacheTime: 0 }), /invocation budget reached/); assert.equal(requests, RPC_LIMIT);
});
test("incremental audit resumes cached reads and preserves exact nonce, Transfer and balances checks", async () => {
  const record = purchaseRecord(); const { rpc } = fakeRpc(); const counts = new Map(); let budget = 2;
  const limited = Object.fromEntries(Object.keys(rpc).map(method => [method, async (...args) => { if (--budget < 0) throw new RpcYield("RPC invocation budget reached"); counts.set(method, (counts.get(method) ?? 0) + 1); return rpc[method](...args); }]));
  const options = { validateDelivery: () => {} }; let checkpoints = 0;
  await assert.rejects(incrementalAudit(record, limited, async () => { checkpoints++; }, options), /budget reached/);
  budget = 30; await incrementalAudit(record, limited, async () => { checkpoints++; }, options);
  assert.equal(record.status, "verified"); assert.equal(counts.get("getChainId"), 1); assert.equal(counts.get("waitForTransactionReceipt"), 1); assert.ok(checkpoints > 3);
  assert.equal(publicEvidence(record).auditReads, undefined);
});
test("a mismatched payment nonce never unlocks the prepared result", async () => {
  const f = setup({ auditPayment: async record => { record.audit = { paymentVerified: false }; record.status = "audit_failed"; } });
  await prepare(f); await accept(f); await f.instance.alarm(); await f.instance.alarm();
  const result = await (await f.instance.fetch(request("GET"))).json(); assert.equal(result.status, "needs_attention"); assert.equal(result.delivery, undefined); assert.equal(f.stats.settled, 1);
});
test("v2 report uses free-source evidence without inventing upstream purchase transactions", () => {
  const rs = records(); const works = detailedWorks(rs); const output = { title: "三馆猫", introduction: "一起观察。", stops: works.map(work => ({ key: work.key, minutes: 5, commentary: "观察这件作品。", question: "你看到了什么？" })), conclusion: "交流发现。" };
  const report = renderReport(output, works, { protocolVersion: 2, id, input }, rs); assert.ok(report.includes("免费 API")); assert.equal(report.includes("采购交易：undefined"), false); assert.ok(report.includes("0.003"));
});
test("existing v1 deliveries remain retrievable after the Worker upgrade", async () => {
  const f = setup(); await new JsonStore(f.storage).put("job", { id, tokenHash: sha256(token), requestId: "legacy", status: "complete", input: { goal: input.goal, budgetAtomic: "9000" }, expiresAt: new Date(Date.now() + 100000).toISOString(), calls: [] });
  await new JsonStore(f.storage).put("delivery", { reportMarkdown: "历史成品", reportSha256: sha256("历史成品") });
  const result = await (await f.instance.fetch(request("GET"))).json(); assert.equal(result.delivery.reportMarkdown, "历史成品"); assert.equal(f.stats.settled, 0);
});

test("client preparation sends no signed payment and saves recovery state before the first request", async () => {
  let saved = false; const requests = []; let privateState;
  const result = await submitCloudJob({ goal: input.goal, baseUrl: "https://agent.test", savePrivate: value => { saved = true; privateState = value; }, savePublic: () => {}, fetcher: async req => {
    assert.equal(saved, true); assert.equal(req.headers.has("payment-signature"), false); requests.push(req.url);
    if (req.url.endsWith("/health")) return Response.json({ ready: true, protocolVersion: 2, paymentFlow: "prepare_then_pay_for_delivery", upstreamAccess: "direct_free_api", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", seller, feeAtomic: "3000" });
    if (req.url.endsWith("/F-02.md")) return new Response(`${seller} eip155:84532`);
    return Response.json({ jobId: privateState.id, status: "queued" }, { status: 202 });
  } });
  assert.equal(result.record.paymentsSubmitted, 0); assert.equal(requests.length, 3); assert.equal(result.record.status, "preparing_without_payment");
});
test("client refuses to pay an incomplete result or repeat an ambiguous saved authorization", async () => {
  const state = { id, token, baseUrl: "https://agent.test", input };
  await assert.rejects(payCloudJob(state, { fetcher: async () => Response.json({ jobId: id, status: "fetching" }, { status: 202 }) }), /complete unpaid result/);
  await assert.rejects(payCloudJob(state, { previousRecord: { authorization: payload().payload.authorization }, fetcher: async () => Response.json({ jobId: id, status: "ready" }) }), /saved authorization/);
});
test("client rejects a changed report body even with a matching delivery-local checksum", async () => {
  await assert.rejects(getCloudJob({ id, token, baseUrl: "https://agent.test" }, { fetcher: async () => Response.json({ protocolVersion: 2, jobId: id, summary: { reportSha256: sha256("original") }, delivery: { reportMarkdown: "changed", reportSha256: sha256("changed") } }) }), /integrity/);
});
test("exact unused nonce before expiry never permits a new payment", async () => {
  const record = purchaseRecord(); record.authorization.validBefore = "2000";
  const rpc = { getChainId: async () => 84532, getBlockNumber: async () => 100n, getBlock: async () => ({ timestamp: 1000n }), readContract: async () => false };
  assert.equal(await reconcilePayment(record, rpc, async () => {}), "waiting"); assert.equal(record.reconciliation.safeToRetry, false);
  rpc.getBlock = async () => ({ timestamp: 2013n });
  assert.equal(await reconcilePayment(record, rpc, async () => {}), "confirmed_unpaid"); assert.equal(record.reconciliation.authorizationUsed, false);
});
test("lost settlement reconciliation scans only one 150-block range per alarm", async () => {
  const record = purchaseRecord(); const ranges = [];
  const rpc = { getChainId: async () => 84532, getBlockNumber: async () => 500n, getBlock: async () => ({ timestamp: 1000n }), readContract: async () => true, getLogs: async range => { ranges.push(range); return []; } };
  assert.equal(await reconcilePayment(record, rpc, async () => {}), "scanning"); assert.equal(ranges.length, 1); assert.equal(ranges[0].toBlock - ranges[0].fromBlock, 149n); assert.equal(record.scanNext, "251");
});
