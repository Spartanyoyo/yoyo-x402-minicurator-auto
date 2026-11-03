import { randomBytes } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { NETWORK, USDC } from "../src/app.mjs";
import { curationIdentity, curationInput, AGENT_FEE, readTextBounded, sha256, safeError } from "../src/agent-contract.mjs";
import { balances } from "./chain.mjs";

const request = (fetcher, url, init = {}) => fetcher(new Request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(90000) }));
function origin(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Agent origin must be HTTPS without credentials/path/query");
  return base.origin;
}
async function contract(base, fetcher) {
  const response = await request(fetcher, `${base}/health`);
  const health = JSON.parse(await readTextBounded(response, 8192));
  if (!response.ok || !health.ready || health.protocolVersion !== 2 || health.paymentFlow !== "prepare_then_pay_for_delivery" || health.upstreamAccess !== "direct_free_api" || health.network !== NETWORK || health.asset?.toLowerCase() !== USDC.toLowerCase() || !health.seller || health.feeAtomic !== String(AGENT_FEE)) throw new Error("Agent contract is not the approved free-upstream/result-payment protocol");
  const docs = await request(fetcher, `${base}/F-02.md`); const content = await readTextBounded(docs, 32000);
  if (!docs.ok || !content.includes(health.seller) || !content.includes(NETWORK)) throw new Error("Agent documentation does not bind seller and network");
  return { health, documentation: { url: `${base}/F-02.md`, content, sha256: sha256(content), readAt: new Date().toISOString() } };
}

export async function submitCloudJob({ goal, maxCalls = 24, baseUrl, fetcher = fetch, savePrivate, savePublic }) {
  const base = origin(baseUrl); const input = curationInput({ goal, maxCalls });
  const token = randomBytes(32).toString("hex"); const id = curationIdentity(input, token);
  const privateState = { protocolVersion: 2, id, token, baseUrl: base, input };
  await savePrivate(privateState);
  const { health, documentation } = await contract(base, fetcher);
  const response = await request(fetcher, `${base}/jobs/${id}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const result = JSON.parse(await readTextBounded(response));
  if (response.status !== 202 || result.jobId !== id) throw new Error(`Free preparation rejected: HTTP ${response.status}; ${result.error ?? "invalid response"}`);
  const record = { protocolVersion: 2, jobId: id, baseUrl: base, input, seller: health.seller, status: "preparing_without_payment", documentation, preparation: { httpStatus: response.status, receivedAt: new Date().toISOString() }, paymentsSubmitted: 0 };
  await savePublic(record);
  return { privateState, record };
}

export async function payCloudJob(state, { buyer, rpc, fetcher = fetch, savePrivate, savePublic, previousRecord } = {}) {
  const status = await getCloudJob(state, { fetcher });
  if (!["ready", "payment_retry_allowed"].includes(status.status)) throw new Error("A complete unpaid result is required before payment");
  if (previousRecord?.authorization && !(status.status === "payment_retry_allowed" && status.incoming?.reconciliation?.safeToRetry && status.incoming.authorization.nonce === previousRecord.authorization.nonce)) throw new Error("A saved authorization may already have been submitted; use read-only reconciliation first");
  const base = origin(state.baseUrl); const target = `${base}/jobs/${state.id}/delivery`;
  const { health, documentation } = await contract(base, fetcher);
  const record = { protocolVersion: 2, at: new Date().toISOString(), jobId: state.id, baseUrl: base, input: state.input, buyer: buyer.address, seller: health.seller, network: NETWORK, asset: USDC, reportSha256: status.summary.reportSha256, status: "preflight", documentation, http: [], ...(previousRecord?.authorization ? { priorAttempts: [...(previousRecord.priorAttempts ?? []), previousRecord] } : {}) };
  await savePublic(record);
  try {
    const headers = { Authorization: `Bearer ${state.token}` };
    const unpaid = await request(fetcher, target, { method: "POST", headers });
    const header = unpaid.headers.get("PAYMENT-REQUIRED");
    if (unpaid.status !== 402 || !header || header.length > 16384) throw new Error("Missing or oversized completed-result x402 quote");
    const quote = decodePaymentRequiredHeader(header); await unpaid.body?.cancel();
    if (quote.x402Version !== 2 || quote.resource?.url !== target || !quote.resource.description?.includes(record.reportSha256)) throw new Error("Quote does not bind this completed report and job");
    const client = new x402Client().register(NETWORK, new ExactEvmScheme(buyer));
    client.setSpendControls({ maxAmountPerPayment: "$0.003" });
    client.registerPolicy((version, requirements) => version === 2 ? requirements.filter(r => r.scheme === "exact" && r.network === NETWORK && r.asset.toLowerCase() === USDC.toLowerCase() && r.payTo.toLowerCase() === record.seller.toLowerCase() && r.amount === String(AGENT_FEE) && r.maxTimeoutSeconds === 300 && r.extra?.name === "USDC" && r.extra?.version === "2" && !r.extra?.paymentFlow && !r.extra?.assetTransferMethod) : []);
    if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
    record.before = await balances(rpc, buyer.address, record.seller, await rpc.getBlockNumber({ cacheTime: 0 }));
    if (BigInt(record.before.buyer) < BigInt(AGENT_FEE)) throw new Error("Insufficient test USDC for the completed result");
    const payload = await client.createPaymentPayload(quote);
    record.authorization = { ...payload.payload.authorization }; record.status = "signed_not_submitted"; await savePublic(record);
    state.paymentAttempted = true; await savePrivate(state);
    record.status = "payment_submitted_outcome_pending"; await savePublic(record);
    const paid = await request(fetcher, target, { method: "POST", headers: { ...headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
    const receipt = paid.headers.get("PAYMENT-RESPONSE");
    if (receipt) record.settlement = decodePaymentResponseHeader(receipt);
    record.http.push({ paid: true, status: paid.status, receivedAt: new Date().toISOString(), headers: { "x-request-id": paid.headers.get("x-request-id") } });
    await savePublic(record);
    record.response = JSON.parse(await readTextBounded(paid));
    if (![200, 202].includes(paid.status) || record.response.jobId !== state.id || record.response.summary?.reportSha256 !== record.reportSha256) throw new Error("Payment acceptance unknown; reconcile this saved job without resubmitting");
    record.status = "accepted_awaiting_settlement_and_audit";
  } catch (error) { record.error = safeError(error); record.status = record.authorization ? "outcome_unknown_check_chain_before_retry" : "not_submitted"; }
  await savePublic(record); return record;
}

export async function getCloudJob(state, { fetcher = fetch, reconcile = false } = {}) {
  const response = await request(fetcher, `${origin(state.baseUrl)}/jobs/${state.id}${reconcile ? "/reconcile" : ""}`, { method: reconcile ? "POST" : "GET", headers: { Authorization: `Bearer ${state.token}` } });
  const result = JSON.parse(await readTextBounded(response));
  if (![200, 202].includes(response.status) || result.jobId !== state.id) throw new Error(`Job retrieval failed: HTTP ${response.status}`);
  if (result.delivery && (sha256(result.delivery.reportMarkdown) !== result.delivery.reportSha256 || result.protocolVersion === 2 && result.summary.reportSha256 !== result.delivery.reportSha256)) throw new Error("Delivery integrity check failed");
  return result;
}
