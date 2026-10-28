import test from "node:test";
import assert from "node:assert/strict";
import { validateProbe } from "../scripts/probe-checks.mjs";
import { NETWORK, USDC } from "../src/app.mjs";
import { seller, signer } from "./fixtures.mjs";

function probeRecord() {
  const baseUrl = "https://service.test";
  const headers = { "x-request-id": "test-request", "cache-control": "no-store" };
  return {
    baseUrl,
    "/F-02.md": { status: 200, headers, body: `${baseUrl} ${seller} ${NETWORK} ${USDC}` },
    "/health": { status: 200, headers, body: { service: "yoyo-x402-weather", network: NETWORK, seller, asset: USDC, priceAtomic: "1000" } },
    "/weather?latitude=31.2304&longitude=121.4737": { status: 402, headers, paymentRequired: { x402Version: 2, resource: { url: `${baseUrl}/weather?latitude=31.2304&longitude=121.4737` }, accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: seller }] } },
  };
}

test("probe validates documentation, health and quote beyond HTTP status codes", () => {
  validateProbe(probeRecord(), seller);
});

for (const [name, mutate] of [
  ["missing quote", record => { delete record["/weather?latitude=31.2304&longitude=121.4737"].paymentRequired; }],
  ["wrong price", record => { record["/health"].body.priceAtomic = "999"; }],
  ["wrong seller", record => { record["/health"].body.seller = signer.address; }],
  ["empty documentation", record => { record["/F-02.md"].body = ""; }],
  ["unresolved document template", record => { record["/F-02.md"].body += " {{BASE_URL}}"; }],
  ["cacheable quote", record => { record["/weather?latitude=31.2304&longitude=121.4737"].headers = { "x-request-id": "test" }; }],
]) {
  test(`probe cannot pass with ${name}`, () => {
    const record = probeRecord();
    mutate(record);
    assert.throws(() => validateProbe(record, seller));
  });
}
