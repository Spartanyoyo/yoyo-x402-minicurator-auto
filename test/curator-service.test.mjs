import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createCuratorApp } from "../src/curator-app.mjs";
import { SERVICES, CatalogError } from "../src/curator-catalog.mjs";
import { NETWORK, USDC } from "../src/app.mjs";
import { resource } from "./curator-fixtures.mjs";
import { seller, signer, transaction } from "./fixtures.mjs";

const documentation = readFileSync(new URL("../docs/F-02_minicurator.md", import.meta.url), "utf8");
function fixture({ valid = true, settled = true, fail = false, corrupt = false } = {}) {
  const calls = { upstream: 0, settled: 0 };
  const facilitator = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} }), verify: async () => ({ isValid: valid, ...(valid ? {} : { invalidReason: "invalid_signature" }) }), settle: async () => { calls.settled++; return { success: settled, transaction: settled ? transaction : "", network: NETWORK, payer: signer.address, ...(settled ? {} : { errorReason: "simulated_rejection" }) }; } };
  const app = createCuratorApp({ seller, documentation, facilitator, fetchResource: async service => { calls.upstream++; if (fail) throw new CatalogError("upstream failed"); const data = resource(service); if (corrupt) data.service = "other"; return data; } });
  return { app, calls };
}
function target(service) { const s = SERVICES[service]; return `https://service.test${s.path}${new URLSearchParams(s.example).size ? `?${new URLSearchParams(s.example)}` : ""}`; }
async function signed(app, service) {
  const quote = await app.request(target(service));
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
  const payment = await client.createPaymentPayload(decodePaymentRequiredHeader(quote.headers.get("payment-required")));
  return app.request(target(service), { headers: new x402HTTPClient(client).encodePaymentSignatureHeader(payment) });
}

for (const service of Object.keys(SERVICES)) {
  test(`${service}: free documentation/health and independent exact unpaid quote`, async () => {
    const { app, calls } = fixture(); const s = SERVICES[service];
    const docs = await app.request(`https://service.test${s.documentationPath}`); const body = await docs.text();
    assert.equal(docs.status, 200); assert.ok(body.includes(service) && body.includes(seller) && body.includes(NETWORK) && body.includes(s.path) && body.includes("2 MiB")); assert.ok(!body.includes("{{"));
    assert.equal((await app.request(s.healthPath)).status, 200);
    const response = await app.request(target(service)); assert.equal(response.status, 402);
    const quote = decodePaymentRequiredHeader(response.headers.get("payment-required"));
    assert.equal(quote.resource.url, target(service)); assert.equal(quote.accepts[0].amount, "1000"); assert.equal(quote.accepts[0].asset, USDC); assert.equal(quote.accepts[0].payTo, seller); assert.equal(quote.accepts[0].network, NETWORK);
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.deepEqual(calls, { upstream: 0, settled: 0 });
  });
  test(`${service}: paid response contains the purchased data, matching request ID and receipt`, async () => {
    const { app, calls } = fixture(); const response = await signed(app, service); assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.resource.service, service); assert.equal(body.requestId, response.headers.get("x-request-id")); assert.ok(response.headers.get("payment-response")); assert.deepEqual(calls, { upstream: 1, settled: 1 });
  });
}

test("API unsupported methods and invalid parameters cannot acquire or settle data", async () => {
  const { app, calls } = fixture();
  for (const service of Object.keys(SERVICES)) for (const method of ["HEAD", "POST", "OPTIONS", "DELETE"]) assert.equal((await app.request(target(service), { method })).status, 405);
  for (const path of ["/api/met-search?q=cat&q=dog", "/api/cma-artwork?id=0", "/api/met-departments?url=x", "/api/smk-search?q=cat&limit=100"]) assert.equal((await app.request(path)).status, 400);
  assert.equal((await app.request("/api/unknown")).status, 404); assert.deepEqual(calls, { upstream: 0, settled: 0 });
});

test("rejected authorization never runs the museum adapter", async () => {
  const { app, calls } = fixture({ valid: false }); assert.equal((await signed(app, "met-artwork")).status, 402); assert.deepEqual(calls, { upstream: 0, settled: 0 });
});
test("oversized payment headers and URLs are rejected before verification/acquisition", async () => {
  const { app, calls } = fixture();
  for (const name of ["payment-signature", "x-payment"]) {
    const response = await app.request(target("met-artwork"), { headers: { [name]: "A".repeat(8193) } });
    assert.equal(response.status, 431); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await app.request(`/api/met-search?q=${"a".repeat(2100)}`)).status, 414);
  assert.deepEqual(calls, { upstream: 0, settled: 0 });
});
for (const option of ["fail", "corrupt"]) test(`${option}: upstream/contract failure never settles`, async () => {
  const { app, calls } = fixture({ [option]: true }); const response = await signed(app, "met-artwork"); assert.equal(response.status, 502); assert.equal(calls.settled, 0);
});
test("settlement rejection withholds prepared museum data", async () => {
  const { app, calls } = fixture({ settled: false }); const response = await signed(app, "met-artwork"); assert.ok(response.status >= 400); assert.ok(!(await response.text()).includes('"title":"Cat"')); assert.equal(calls.settled, 1);
});
