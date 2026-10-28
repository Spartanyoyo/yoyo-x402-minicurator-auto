import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp, NETWORK, USDC } from "../src/app.mjs";
import { coordinates, weatherAt } from "../src/weather.mjs";

const seller = "0x303782B1b788527bE6cC28C6F16aA2A3Ba26b59f";
const documentation = readFileSync(new URL("../docs/F-02_weather-service.md", import.meta.url), "utf8");

function fixture({ valid = true, settled = true, failWeather = false } = {}) {
  const calls = { weather: 0, settled: 0 };
  const facilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: valid, ...(valid ? {} : { invalidReason: "invalid_signature" }) }),
    settle: async () => {
      calls.settled++;
      return { success: settled, transaction: settled ? `0x${"ab".repeat(32)}` : "", network: NETWORK, ...(settled ? {} : { errorReason: "test_settlement_rejected" }) };
    },
  };
  const app = createApp({ seller, documentation, facilitator, fetchWeather: async () => {
    calls.weather++;
    if (failWeather) throw new Error("Simulated upstream failure");
    return { simulationMarker: "UNIT_TEST_ONLY_NOT_LIVE_WEATHER" };
  } });
  return { app, calls };
}

async function signedRequest(app) {
  const url = "http://service.test/weather?latitude=31.2304&longitude=121.4737";
  const quote = await app.request(url);
  const required = decodePaymentRequiredHeader(quote.headers.get("payment-required"));
  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
  const payload = await client.createPaymentPayload(required);
  return app.request(url, { headers: new x402HTTPClient(client).encodePaymentSignatureHeader(payload) });
}

test("unpaid valid query returns exact quote without reading weather", async () => {
  const { app, calls } = fixture();
  const response = await app.request("/weather?latitude=31.2304&longitude=121.4737");
  assert.equal(response.status, 402);
  const quote = decodePaymentRequiredHeader(response.headers.get("payment-required"));
  assert.equal(quote.x402Version, 2);
  assert.deepEqual([quote.accepts[0].network, quote.accepts[0].asset, quote.accepts[0].amount, quote.accepts[0].payTo], [NETWORK, USDC, "1000", seller]);
  assert.equal(calls.weather, 0);
  assert.equal(calls.settled, 0);
});

test("F-02 is free and resolves the actual base URL and seller", async () => {
  const { app } = fixture();
  const response = await app.request("https://service.test/F-02.md");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes("https://service.test"));
  assert.ok(body.includes(seller));
  assert.ok(!body.includes("{{"));
});

test("missing and out-of-range coordinates are rejected before payment", async () => {
  const { app, calls } = fixture();
  for (const query of ["", "latitude=&longitude=0", "latitude=91&longitude=0", "latitude=no&longitude=3"]) {
    assert.equal((await app.request(`/weather?${query}`)).status, 400);
  }
  assert.deepEqual(calls, { weather: 0, settled: 0 });
  assert.deepEqual(coordinates({ latitude: "0", longitude: "0" }), { latitude: 0, longitude: 0 });
});

test("unsupported weather methods never execute the paid handler", async () => {
  const { app, calls } = fixture();
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await app.request("/weather?latitude=0&longitude=0", { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(response.headers.get("payment-response"), null);
  }
  assert.deepEqual(calls, { weather: 0, settled: 0 });
});

test("ambiguous and non-decimal coordinates are rejected before payment", async () => {
  const { app, calls } = fixture();
  for (const query of [
    "latitude=0x20&longitude=0",
    "latitude=0&longitude=0b10",
    "latitude=1e1&longitude=0",
    "latitude=0&latitude=90&longitude=0",
    "latitude=0&longitude=0&longitude=90",
  ]) {
    assert.equal((await app.request(`/weather?${query}`)).status, 400, query);
  }
  assert.deepEqual(calls, { weather: 0, settled: 0 });
});

test("rejected payment never runs the weather handler", async () => {
  const { app, calls } = fixture({ valid: false });
  const response = await signedRequest(app);
  assert.equal(response.status, 402);
  assert.deepEqual(calls, { weather: 0, settled: 0 });
});

test("settlement failure withholds weather body", async () => {
  const { app, calls } = fixture({ settled: false });
  const response = await signedRequest(app);
  assert.ok(response.status >= 400);
  assert.ok(!(await response.text()).includes("UNIT_TEST_ONLY_NOT_LIVE_WEATHER"));
  assert.equal(calls.settled, 1);
});

test("upstream failure returns an error without settling exact payment", async () => {
  const { app, calls } = fixture({ failWeather: true });
  const response = await signedRequest(app);
  assert.equal(response.status, 502);
  assert.equal(calls.weather, 1);
  assert.equal(calls.settled, 0);
});

test("successful simulated settlement includes payment receipt", async () => {
  const { app, calls } = fixture();
  const response = await signedRequest(app);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("payment-response"));
  assert.equal(calls.settled, 1);
});

test("weather adapter retains units, provenance, forecast time and caches upstream", async () => {
  let calls = 0;
  const time = new Date().toISOString();
  const upstream = async () => {
    calls++;
    return new Response(JSON.stringify({ properties: { meta: { updated_at: time, units: { air_temperature: "celsius", relative_humidity: "%", wind_speed: "m/s" } }, timeseries: [{ time, data: { instant: { details: { air_temperature: 18, relative_humidity: 50, wind_speed: 2 } } } }] } }), { headers: { Expires: new Date(Date.now() + 60000).toUTCString() } });
  };
  const first = await weatherAt({ latitude: 10.1234, longitude: 10.1234 }, upstream);
  await weatherAt({ latitude: 10.1234, longitude: 10.1234 }, upstream);
  assert.equal(calls, 1);
  assert.deepEqual(first.temperature, { value: 18, unit: "celsius" });
  assert.equal(first.forecastTime, time);
  assert.ok(first.dataType.includes("not_station_observation"));
  assert.ok(first.attribution.includes("MET Norway"));
});
