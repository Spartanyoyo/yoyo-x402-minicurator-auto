import test from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { purchaseWeather } from "../scripts/purchase.mjs";
import { NETWORK, USDC } from "../src/app.mjs";
import { authorizationNonce, fakeRpc, signer, seller, transaction, weather } from "./fixtures.mjs";

function fixture({ changeQuote, body, document = `${seller} ${NETWORK}`, documentErrorOnce = false, quoteErrorOnce = false, paidStatus = 200, paidError, rpcOptions, paidHeaders = {} } = {}) {
  const calls = [];
  const snapshots = [];
  let observedAuthorizationNonce = authorizationNonce;
  const fetcher = async request => {
    const paid = request.headers.has("payment-signature");
    calls.push({ url: request.url, paid, redirect: request.redirect });
    if (request.url.endsWith("/F-02.md")) {
      if (documentErrorOnce && calls.length === 1) throw new Error("Temporary documentation connection failure");
      return new Response(document);
    }
    if (!paid) {
      if (quoteErrorOnce) {
        quoteErrorOnce = false;
        throw new Error("Temporary quote connection failure");
      }
      const quote = { x402Version: 2, resource: { url: request.url, mimeType: "application/json" }, accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: seller, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
      changeQuote?.(quote);
      return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(quote) } });
    }
    const payload = decodePaymentSignatureHeader(request.headers.get("payment-signature"));
    observedAuthorizationNonce = payload.payload.authorization.nonce;
    assert.equal(payload.payload.authorization.value, "1000");
    assert.equal(payload.payload.authorization.to.toLowerCase(), seller.toLowerCase());
    if (paidError) throw paidError;
    return new Response(body ?? JSON.stringify({ requestId: "request-test", weather: weather() }), { status: paidStatus, headers: {
      "content-type": "application/json", "x-request-id": "request-test",
      "payment-response": encodePaymentResponseHeader({ success: true, transaction, network: NETWORK, payer: signer.address }), ...paidHeaders,
    } });
  };
  const options = { baseUrl: "https://service.test", latitude: "31.2304", longitude: "121.4737", intent: "Weather test", seller, buyer: signer, rpc: fakeRpc({ ...rpcOptions, authorizationEventNonce: () => observedAuthorizationNonce }).rpc, fetcher, save: record => snapshots.push(structuredClone(record)) };
  return { calls, snapshots, options };
}

test("buyer reads documentation, signs once and verifies payment plus delivery", async () => {
  const { options, calls, snapshots } = fixture();
  const record = await purchaseWeather(options);
  assert.equal(record.status, "verified", record.error);
  assert.deepEqual(calls.map(call => call.paid), [false, false, true]);
  assert.ok(calls[0].url.endsWith("/F-02.md"));
  assert.ok(calls.every(call => call.redirect === "error"));
  assert.ok(record.authorization.nonce);
  assert.ok(record.authorization.expiresAt);
  assert.equal(record.authorization.signature, undefined);
  assert.ok(snapshots.some(snapshot => snapshot.status === "settled_audit_pending" && snapshot.settlement.transaction === transaction && !snapshot.response));
});

test("documentation connection failure permits one recorded read-only retry", async () => {
  const { options, calls } = fixture({ documentErrorOnce: true });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "verified", record.error);
  assert.equal(record.preflightErrors.length, 1);
  assert.equal(calls.filter(call => call.url.endsWith("/F-02.md")).length, 2);
  assert.equal(calls.filter(call => call.paid).length, 1);
});

test("persistent documentation connection failure stops before signing", async () => {
  const { options } = fixture();
  let calls = 0;
  options.fetcher = async () => { calls++; throw new Error("Documentation unavailable"); };
  const record = await purchaseWeather(options);
  assert.equal(record.status, "not_verified");
  assert.equal(record.preflightErrors.length, 2);
  assert.equal(calls, 2);
  assert.equal(record.authorization, undefined);
});

test("quote connection failure permits one recorded retry without duplicate payment", async () => {
  const { options, calls } = fixture({ quoteErrorOnce: true });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "verified", record.error);
  assert.equal(record.preflightErrors.length, 1);
  assert.equal(record.preflightErrors[0].operation, "read_payment_quote");
  assert.equal(calls.filter(call => call.paid).length, 1);
  assert.equal(calls.filter(call => !call.paid && call.url.includes("/weather?")).length, 2);
});

test("persistent quote connection failure stops after one retry and never signs", async () => {
  const { options, calls } = fixture();
  let quoteCalls = 0;
  const normalFetcher = options.fetcher;
  options.fetcher = async request => {
    if (request.url.endsWith("/F-02.md")) return normalFetcher(request);
    quoteCalls++;
    throw new Error("Quote unavailable");
  };
  const record = await purchaseWeather(options);
  assert.equal(record.status, "not_verified");
  assert.equal(record.authorization, undefined);
  assert.equal(quoteCalls, 2);
  assert.equal(calls.filter(call => call.paid).length, 0);
});

for (const [name, changeQuote] of [
  ["excessive amount", q => { q.accepts[0].amount = "1001"; }],
  ["wrong seller", q => { q.accepts[0].payTo = signer.address; }],
  ["wrong asset", q => { q.accepts[0].asset = signer.address; }],
  ["mainnet", q => { q.accepts[0].network = "eip155:8453"; }],
  ["excessive authorization lifetime", q => { q.accepts[0].maxTimeoutSeconds = 86400; }],
  ["upfront payment", q => { q.accepts[0].extra.paymentFlow = "upfront"; }],
  ["different resource", q => { q.resource.url = "https://other.test/weather"; }],
]) {
  test(`buyer rejects ${name} before signing`, async () => {
    const { options, calls } = fixture({ changeQuote });
    const record = await purchaseWeather(options);
    assert.equal(record.status, "not_verified");
    assert.equal(record.authorization, undefined);
    assert.equal(calls.filter(call => call.paid).length, 0);
  });
}

test("malformed weather body preserves and audits the successful payment receipt", async () => {
  const { options, calls } = fixture({ body: "<html>truncated body" });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "paid_delivery_failed", record.error);
  assert.equal(record.settlement.transaction, transaction);
  assert.equal(record.audit.paymentVerified, true);
  assert.equal(record.responseText, "<html>truncated body");
  assert.equal(calls.filter(call => call.paid).length, 1);
});

test("successful payment with empty JSON is never marked as a complete purchase", async () => {
  const { options } = fixture({ body: "{}" });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "paid_delivery_failed");
  assert.equal(record.audit.paymentVerified, true);
});

test("lost paid response preserves public authorization and forbids automatic repayment", async () => {
  const { options, calls } = fixture({ paidError: new Error("Network disconnected") });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "outcome_unknown_check_chain_before_retry");
  assert.ok(record.authorization.nonce);
  assert.ok(record.authorization.validBefore);
  assert.equal(calls.filter(call => call.paid).length, 1);
});

test("RPC failure after settlement leaves a receipt available for read-only recovery", async () => {
  const { options, calls } = fixture({ rpcOptions: { receiptError: new Error("RPC timeout") } });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "settled_audit_pending");
  assert.equal(record.settlement.transaction, transaction);
  assert.equal(calls.filter(call => call.paid).length, 1);
});

test("buyer refuses mismatched documentation without starting weather requests", async () => {
  const { options, calls } = fixture({ document: "Wrong service" });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "not_verified");
  assert.equal(calls.length, 1);
  assert.ok(record.documentation.sha256);
});

test("insufficient funds stop the buyer before payment creation", async () => {
  const { options, calls } = fixture({ rpcOptions: { buyerBalance: 999n } });
  const record = await purchaseWeather(options);
  assert.equal(record.status, "not_verified");
  assert.equal(calls.length, 1);
});
