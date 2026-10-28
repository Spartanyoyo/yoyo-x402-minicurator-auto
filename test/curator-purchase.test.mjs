import test from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { purchaseCurator } from "../scripts/curator-purchase.mjs";
import { NETWORK, USDC } from "../src/app.mjs";
import { SERVICES } from "../src/curator-catalog.mjs";
import { resource } from "./curator-fixtures.mjs";
import { authorizationNonce, fakeRpc, signer, seller, transaction } from "./fixtures.mjs";

function fixture({ service = "met-artwork", changeQuote, changeBody, paidError, document, receiptError } = {}) {
  const calls = [];
  const snapshots = [];
  let observedAuthorizationNonce = authorizationNonce;
  const options = { service, parameters: SERVICES[service].example, intent: "给十岁孩子准备十五分钟猫主题展览", seller, buyer: signer, baseUrl: "https://service.test", rpc: fakeRpc({ receiptError, authorizationEventNonce: () => observedAuthorizationNonce }).rpc, save: record => snapshots.push(structuredClone(record)), fetcher: async request => {
    const paid = request.headers.has("payment-signature"); calls.push({ url: request.url, paid });
    if (request.url.endsWith(".md")) return new Response(document ?? `${seller} ${NETWORK} ${service} ${SERVICES[service].path} "priceAtomic": "1000"`);
    if (!paid) {
      const quote = { x402Version: 2, resource: { url: request.url, mimeType: "application/json" }, accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: seller, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] }; changeQuote?.(quote);
      return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(quote) } });
    }
    const payment = decodePaymentSignatureHeader(request.headers.get("payment-signature")); observedAuthorizationNonce = payment.payload.authorization.nonce; assert.equal(payment.payload.authorization.value, "1000");
    if (paidError) throw paidError;
    const body = { requestId: "curator-test", resource: resource(service) }; changeBody?.(body);
    return Response.json(body, { headers: { "x-request-id": "curator-test", "payment-response": encodePaymentResponseHeader({ success: true, network: NETWORK, transaction, payer: signer.address }) } });
  } };
  return { options, calls, snapshots };
}

for (const service of Object.keys(SERVICES)) test(`${service}: buyer independently verifies exact payment and resource delivery`, async () => {
  const { options, calls, snapshots } = fixture({ service }); const record = await purchaseCurator(options);
  assert.equal(record.status, "verified", record.error); assert.ok(record.audit.paymentVerified && record.audit.deliveryVerified);
  assert.equal(calls[0].url, `https://service.test${SERVICES[service].documentationPath}`); assert.deepEqual(calls.map(call => call.paid), [false, false, true]);
  assert.ok(record.documentation.sha256 && record.authorization.nonce); assert.equal(record.authorization.signature, undefined);
  assert.ok(snapshots.some(value => value.settlement?.success && !value.response));
});

for (const [name, changeBody] of [
  ["wrong resource", body => { body.resource.service = "cma-artwork"; }],
  ["wrong query", body => { body.resource.query.id = 1; }],
  ["wrong artwork", body => { body.resource.items[0].id = "1"; }],
  ["unverified rights", body => { body.resource.items[0].rights.publicDomain = false; }],
  ["untrusted image", body => { body.resource.items[0].imageUrl = "https://evil.test/img.jpg"; }],
  ["missing cache status", body => { delete body.resource.cache; }],
  ["wrong request ID", body => { body.requestId = "unrelated"; }],
]) test(`buyer marks paid delivery failed for ${name} and never repeats payment`, async () => {
  const { options, calls } = fixture({ changeBody }); const record = await purchaseCurator(options);
  assert.equal(record.status, "paid_delivery_failed"); assert.equal(record.audit.paymentVerified, true); assert.equal(calls.filter(call => call.paid).length, 1);
});

test("another service's documentation cannot authorize a museum purchase", async () => {
  const { options, calls } = fixture({ document: `${seller} ${NETWORK} wrong-service` }); const record = await purchaseCurator(options); assert.equal(record.status, "not_verified"); assert.equal(record.authorization, undefined); assert.equal(calls.length, 1);
});

test("a quote for another API is rejected before signing", async () => {
  const { options, calls } = fixture({ changeQuote: quote => { quote.resource.url = "https://service.test/api/cma-artwork?id=152829"; } }); const record = await purchaseCurator(options); assert.equal(record.status, "not_verified"); assert.equal(record.authorization, undefined); assert.equal(calls.filter(call => call.paid).length, 0);
});
test("oversized quotes cannot reach schema parsing or signing", async () => {
  const { options, calls } = fixture({ changeQuote: quote => { quote.resource.description = "a".repeat(17000); } });
  const record = await purchaseCurator(options); assert.equal(record.status, "not_verified"); assert.equal(record.authorization, undefined); assert.equal(calls.filter(call => call.paid).length, 0);
});

test("a lost paid response records unknown outcome and one submission only", async () => {
  const { options, calls } = fixture({ paidError: new Error("connection lost") }); const record = await purchaseCurator(options); assert.equal(record.status, "outcome_unknown_check_chain_before_retry"); assert.ok(record.authorization.expiresAt); assert.equal(calls.filter(call => call.paid).length, 1);
});

test("receipt audit failure preserves settlement for read-only recovery", async () => {
  const { options, calls } = fixture({ receiptError: new Error("RPC offline") }); const record = await purchaseCurator(options); assert.equal(record.status, "settled_audit_pending"); assert.equal(record.settlement.transaction, transaction); assert.equal(calls.filter(call => call.paid).length, 1);
});

test("invalid query or insufficient purchase budget fails without network calls", async () => {
  const { options, calls } = fixture(); await assert.rejects(purchaseCurator({ ...options, maxAmountAtomic: "999" })); await assert.rejects(purchaseCurator({ ...options, parameters: { id: "0" } })); assert.equal(calls.length, 0);
});
