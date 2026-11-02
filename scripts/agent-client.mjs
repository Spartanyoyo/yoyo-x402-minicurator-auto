import { randomBytes } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { NETWORK, USDC } from "../src/app.mjs";
import { taskIdentity, taskInput, paymentAmount, readTextBounded, sha256 } from "../src/agent-contract.mjs";
import { balances, auditPurchase } from "./chain.mjs";

export async function submitCloudJob({ goal, budgetAtomic = "9000", baseUrl, buyer, rpc, fetcher = fetch, savePrivate, savePublic }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Agent origin must be HTTPS without credentials/path/query");
  const input = taskInput({ goal, budgetAtomic }); const token = randomBytes(32).toString("hex"); const id = taskIdentity(input, token);
  const target = new URL(`/jobs/${id}`, base).href; const privateState = { id, token, baseUrl: base.origin, input };
  await savePrivate(privateState);
  const record = { at: new Date().toISOString(), jobId: id, baseUrl: base.origin, input, buyer: buyer.address, network: NETWORK, asset: USDC, status: "preflight", http: [] };
  await savePublic(record);
  try {
    const request = (path, init = {}) => fetcher(new Request(new URL(path, base), { ...init, redirect: "error", signal: AbortSignal.timeout(90000) }));
    const healthResponse = await request("/health"); const health = JSON.parse(await readTextBounded(healthResponse, 8192));
    if (!healthResponse.ok || !health.ready || health.network !== NETWORK || health.asset.toLowerCase() !== USDC.toLowerCase() || !health.seller) throw new Error("Agent is not ready on the approved network");
    record.seller = health.seller;
    const docsResponse = await request("/F-02.md"); const content = await readTextBounded(docsResponse, 32000);
    if (!docsResponse.ok || !content.includes(health.seller) || !content.includes(NETWORK)) throw new Error("Agent documentation does not bind seller and network");
    record.documentation = { url: new URL("/F-02.md", base).href, content, sha256: sha256(content), readAt: new Date().toISOString() };
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const init = { method: "POST", headers, body: JSON.stringify(input) };
    const unpaid = await request(target, init);
    const quoteHeader = unpaid.headers.get("PAYMENT-REQUIRED");
    if (unpaid.status !== 402 || !quoteHeader || quoteHeader.length > 16384) throw new Error("Missing or oversized x402 quote");
    const quote = decodePaymentRequiredHeader(quoteHeader); await unpaid.body?.cancel();
    if (quote.x402Version !== 2 || quote.resource?.url !== target) throw new Error("Quote does not bind this goal, budget and recovery token");
    const client = new x402Client().register(NETWORK, new ExactEvmScheme(buyer));
    client.setSpendControls({ maxAmountPerPayment: "$0.012" });
    client.registerPolicy((version, requirements) => version === 2 ? requirements.filter(r => r.scheme === "exact" && r.network === NETWORK && r.asset.toLowerCase() === USDC.toLowerCase() && r.payTo.toLowerCase() === record.seller.toLowerCase() && r.amount === paymentAmount(input) && r.maxTimeoutSeconds === 300 && r.extra?.name === "USDC" && r.extra?.version === "2" && !r.extra?.paymentFlow && !r.extra?.assetTransferMethod) : []);
    if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
    record.before = await balances(rpc, buyer.address, record.seller, await rpc.getBlockNumber({ cacheTime: 0 }));
    if (BigInt(record.before.buyer) < BigInt(paymentAmount(input))) throw new Error("Insufficient test USDC for the job");
    const payload = await client.createPaymentPayload(quote);
    record.authorization = { ...payload.payload.authorization }; record.status = "signed_not_submitted"; await savePublic(record);
    record.status = "payment_submitted_outcome_pending"; await savePublic(record);
    const response = await request(target, { ...init, headers: { ...headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
    const receipt = response.headers.get("PAYMENT-RESPONSE");
    if (receipt) record.settlement = decodePaymentResponseHeader(receipt);
    record.http.push({ paid: true, status: response.status, receivedAt: new Date().toISOString(), headers: { "x-request-id": response.headers.get("x-request-id") } });
    await savePublic(record);
    record.response = JSON.parse(await readTextBounded(response)); await savePublic(record);
    if (!record.settlement?.success) throw new Error("Incoming payment outcome unknown; recover this job, never submit a new one automatically");
    await auditPurchase(record, rpc, { expectedAmount: paymentAmount(input), allowConcurrentTransfers: true, deliveryStatus: 202, validateDelivery: response => { if (response.jobId !== id) throw new Error("Wrong accepted job"); } });
  } catch (error) {
    record.error = /https?:|Bearer |sk-/i.test(error.message) ? "External operation failed; use saved job and read-only recovery" : error.message.slice(0, 600);
    if (record.status !== "verified") record.status = record.settlement?.success ? "settled_audit_pending" : record.authorization ? "outcome_unknown_check_chain_before_retry" : "not_submitted";
  }
  await savePublic(record); return { privateState, record };
}

export async function getCloudJob(state, { fetcher = fetch, reconcile = false } = {}) {
  const response = await fetcher(new Request(`${state.baseUrl}/jobs/${state.id}${reconcile ? "/reconcile" : ""}`, { method: reconcile ? "POST" : "GET", headers: { Authorization: `Bearer ${state.token}` }, redirect: "error", signal: AbortSignal.timeout(90000) }));
  const result = JSON.parse(await readTextBounded(response));
  if (![200, 202].includes(response.status) || result.jobId !== state.id) throw new Error(`Job retrieval failed: HTTP ${response.status}`);
  if (result.delivery && sha256(result.delivery.reportMarkdown) !== result.delivery.reportSha256) throw new Error("Delivery integrity check failed");
  return result;
}
