import { createHash } from "node:crypto";
import { isAddress } from "viem";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, USDC, PRICE_ATOMIC } from "../src/app.mjs";
import { coordinates } from "../src/weather.mjs";
import { chainClient, balances, auditPurchase } from "./chain.mjs";
import { isSafePaymentRequirement } from "../src/x402-policy.mjs";

export async function purchaseWeather({ latitude, longitude, intent, ...options }) {
  if (!intent?.trim()) throw new Error("--intent is required to record the user's original weather request");
  const location = coordinates({ latitude, longitude });
  return purchaseDocumentedResource({ ...options, intent, documentPath: "/F-02.md", targetPath: "/weather", parameters: location, recordFields: { location } });
}

// Shared one-signature/one-submit flow. Only the resource descriptor and the
// independent delivery validator differ between weather and museum purchases.
export async function purchaseDocumentedResource({ baseUrl = "http://localhost:4021", intent, seller, buyer, rpc = chainClient(), fetcher = fetch, save = () => {}, documentPath, targetPath, parameters, recordFields = {}, validateDelivery, documentMarkers = [] }) {
  if (!intent?.trim()) throw new Error("--intent is required to record the user's original request");
  const base = new URL(baseUrl);
  const localHttp = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !localHttp) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Use an HTTPS service origin, or HTTP on loopback, without credentials, path or query");
  }
  if (!isAddress(seller) || /^0x0{40}$/i.test(seller) || seller.toLowerCase() === buyer.address.toLowerCase()) {
    throw new Error("SELLER_ADDRESS must be a valid nonzero address distinct from the buyer");
  }
  const record = { ...recordFields, at: new Date().toISOString(), intent, baseUrl: base.origin, buyer: buyer.address, seller, network: NETWORK, asset: USDC, status: "preflight", http: [] };
  const persist = () => save(record);
  persist();
  try {
    let docResponse;
    for (let attempt = 0; ; attempt++) {
      try {
        docResponse = await fetcher(new Request(new URL(documentPath, base), { redirect: "error", signal: AbortSignal.timeout(30000) }));
        break;
      } catch (error) {
        (record.preflightErrors ??= []).push({ operation: "read_documentation", attempt: attempt + 1, at: new Date().toISOString(), message: error.message, cause: error.cause?.message });
        persist();
        if (attempt >= 1) throw error;
      }
    }
    if (!docResponse.ok) throw new Error("Cannot read F-02 before purchase");
    const document = await docResponse.text();
    record.documentation = { url: new URL(documentPath, base).href, readAt: new Date().toISOString(), sha256: createHash("sha256").update(document).digest("hex"), content: document };
    persist();
    if (![seller, NETWORK, ...documentMarkers].every(marker => document.includes(marker))) throw new Error("F-02 does not describe the configured seller/network/resource");
    if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
    record.before = await balances(rpc, buyer.address, seller, await rpc.getBlockNumber({ cacheTime: 0 }));
    persist();
    if (BigInt(record.before.buyer) < BigInt(PRICE_ATOMIC)) throw new Error("Buyer needs at least 0.001 Base Sepolia test USDC; no payment was attempted");
    const client = new x402Client().register(NETWORK, new ExactEvmScheme(buyer));
    client.setSpendControls({ maxAmountPerPayment: "$0.001" });
    client.registerPolicy((version, requirements) => version === 2 ? requirements.filter(requirement => isSafePaymentRequirement(requirement, seller)) : []);
    let signed = false;
    let submitted = false;
    client.onBeforePaymentCreation(async () => {
      if (signed) return { abort: true, reason: "Only one payment signature is allowed per purchase" };
      signed = true;
      record.status = "signing";
      persist();
    });
    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      const authorization = paymentPayload.payload.authorization;
      record.authorization = { ...authorization, expiresAt: new Date(Number(authorization.validBefore) * 1000).toISOString() };
      record.status = "signed_not_submitted";
      persist();
    });
    const target = new URL(targetPath, base);
    for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, String(value));
    const monitoredFetch = async request => {
      if (request.url !== target.href) throw new Error("Refusing request outside this purchase's configured resource URL");
      const paid = request.headers.has("payment-signature");
      if (paid) {
        if (submitted) throw new Error("Only one paid request is allowed per purchase");
        submitted = true;
        record.status = "payment_submitted_outcome_pending";
        persist();
      }
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await fetcher(new Request(request, { redirect: "error", signal: AbortSignal.timeout(90000) }));
          break;
        } catch (error) {
          if (paid || attempt >= 1) throw error;
          (record.preflightErrors ??= []).push({ operation: "read_payment_quote", attempt: attempt + 1, at: new Date().toISOString(), message: error.message, cause: error.cause?.message });
          persist();
        }
      }
      const entry = { url: request.url, paid, status: response.status, receivedAt: new Date().toISOString(), headers: Object.fromEntries(response.headers) };
      record.http.push(entry);
      persist();
      // Preserve settlement before any quote or body decoding can fail.
      if (paid && response.headers.has("payment-response")) {
        record.settlement = new x402HTTPClient(client).getPaymentSettleResponse(name => response.headers.get(name));
        if (record.settlement?.success) record.status = "settled_audit_pending";
        persist();
      }
      const quote = response.headers.get("payment-required");
      if (quote) {
        if (quote.length > 16384) throw new Error("Payment quote exceeds the parser input limit");
        entry.paymentRequired = decodePaymentRequiredHeader(quote);
        persist();
        if (!paid && entry.paymentRequired.resource?.url !== target.href) throw new Error("Payment quote describes a different resource URL");
      }
      return response;
    };
    const response = await wrapFetchWithPayment(monitoredFetch, client)(target, { headers: { Accept: "application/json" } });
    try {
      const text = await response.text();
      try { record.response = JSON.parse(text); }
      catch { record.responseText = text; record.deliveryError = "Data response is not valid JSON"; }
    } catch (error) {
      record.deliveryError = `Cannot read data response: ${error.message}`;
    }
    persist();
    if (!record.settlement?.success || !record.settlement.transaction) throw new Error("No successful settlement receipt; inspect evidence before any retry");
    await auditPurchase(record, rpc, { validateDelivery });
    persist();
    if (record.status !== "verified") throw new Error("Payment or data delivery audit failed; do not repeat payment");
  } catch (error) {
    record.error = error.message;
    if (!["audit_failed", "paid_delivery_failed"].includes(record.status)) {
      record.status = record.settlement?.success ? "settled_audit_pending" : submittedStatus(record);
    }
    persist();
  }
  return record;
}

function submittedStatus(record) {
  return record.status === "payment_submitted_outcome_pending" ? "outcome_unknown_check_chain_before_retry" : "not_verified";
}
