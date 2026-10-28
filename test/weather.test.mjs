import test from "node:test";
import assert from "node:assert/strict";
import { weatherAt } from "../src/weather.mjs";

let sequence = 20;
const location = () => ({ latitude: sequence++, longitude: 10 });
const forecast = () => {
  const time = new Date().toISOString();
  return {
    properties: {
      meta: { updated_at: time, units: { air_temperature: "celsius", relative_humidity: "%", wind_speed: "m/s" } },
      timeseries: [{ time, data: { instant: { details: { air_temperature: 18, relative_humidity: 50, wind_speed: 2 } } } }],
    },
  };
};
const response = payload => new Response(JSON.stringify(payload), { headers: { Expires: new Date(Date.now() + 60000).toUTCString() } });

for (const [name, mutate] of [
  ["missing humidity", p => { delete p.properties.timeseries[0].data.instant.details.relative_humidity; }],
  ["missing wind", p => { delete p.properties.timeseries[0].data.instant.details.wind_speed; }],
  ["null temperature", p => { p.properties.timeseries[0].data.instant.details.air_temperature = null; }],
  ["invalid humidity", p => { p.properties.timeseries[0].data.instant.details.relative_humidity = 101; }],
  ["negative wind", p => { p.properties.timeseries[0].data.instant.details.wind_speed = -1; }],
  ["invalid forecast time", p => { p.properties.timeseries[0].time = "invalid"; }],
  ["stale forecast", p => { p.properties.timeseries[0].time = new Date(Date.now() - 86400000).toISOString(); }],
  ["stale model", p => { p.properties.meta.updated_at = new Date(Date.now() - 2 * 86400000).toISOString(); }],
  ["wrong source units", p => { p.properties.meta.units.air_temperature = "fahrenheit"; }],
]) {
  test(`weather adapter rejects ${name} without caching invalid data`, async () => {
    const point = location();
    const invalid = forecast();
    mutate(invalid);
    await assert.rejects(weatherAt(point, async () => response(invalid)));
    let calls = 0;
    const result = await weatherAt(point, async () => { calls++; return response(forecast()); });
    assert.equal(calls, 1);
    assert.equal(result.temperature.value, 18);
  });
}

test("provider failure is not converted to cached weather", async () => {
  const point = location();
  await assert.rejects(weatherAt(point, async () => new Response("Unavailable", { status: 503 })), /503/);
  assert.equal((await weatherAt(point, async () => response(forecast()))).temperature.value, 18);
});

test("expired cache is conditionally revalidated and preserves retrieval time", async () => {
  const point = location();
  const modified = new Date(Date.now() - 60000).toUTCString();
  const first = await weatherAt(point, async () => new Response(JSON.stringify(forecast()), {
    headers: { Expires: new Date(Date.now() - 1000).toUTCString(), "Last-Modified": modified },
  }));
  let calls = 0;
  const second = await weatherAt(point, async (_url, options) => {
    calls++;
    assert.equal(options.headers["If-Modified-Since"], modified);
    return new Response(null, { status: 304, headers: { Expires: new Date(Date.now() + 60000).toUTCString() } });
  });
  assert.equal(calls, 1);
  assert.equal(second.retrievedAt, first.retrievedAt);
  assert.equal(second.forecastTime, first.forecastTime);
});
