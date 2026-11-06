import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES, MAX_PROVIDER_RESPONSE_BYTES, MAX_STALE_SECONDS, serviceParameters, upstreamUrl, normalizeCatalog, validateCatalog, catalogResource } from "../src/curator-catalog.mjs";
import { raw, query, resource, memoryCache } from "./curator-fixtures.mjs";

for (const service of Object.keys(SERVICES)) {
  test(`${service}: normalizes real upstream fields and validates independent resource identity`, () => {
    const result = resource(service);
    assert.equal(validateCatalog(result, service, query(service)), result);
    assert.ok(result.items.length > 0);
    assert.equal(result.provider, SERVICES[service].provider);
    assert.throws(() => validateCatalog({ ...result, service: "other" }, service, query(service)));
    assert.throws(() => validateCatalog({ ...result, sourceUrl: "https://other.test" }, service, query(service)));
  });
}

test("Met search uses v1.1 pagination, preserves candidate rights uncertainty and accepts empty matches", () => {
  const result = resource("met-search");
  assert.ok(result.sourceUrl.includes("/v1.1/search?"));
  assert.ok(result.items.some(item => item.id === "552027"));
  assert.ok(result.items.every(item => item.rightsVerified === false));
  assert.equal(normalizeCatalog("met-search", query("met-search"), { total: 0, objectIDs: null }).returned, 0);
});

test("CMA creator links and three artwork identities match the selection requirements", () => {
  assert.equal(resource("met-artwork").items[0].id, "552027");
  const work = resource("cma-artwork").items[0];
  assert.equal(work.id, "152829");
  assert.equal(work.title, "Cat and Butterfly");
  assert.equal(work.artists[0].id, "31140");
  assert.ok(resource("cma-artist").items[0].artworks.some(item => item.id === work.id));
  assert.equal(resource("smk-artwork").items[0].title, "The Cat in the Studio");
});

for (const [service, mutate] of [
  ["met-artwork", body => { body.isPublicDomain = false; }],
  ["cma-artwork", body => { body.data.share_license_status = "Copyright"; }],
  ["smk-artwork", body => { body.items[0].public_domain = false; }],
]) test(`${service}: absent or closed rights reject displayable detail`, () => {
  const body = raw(service); mutate(body);
  assert.throws(() => normalizeCatalog(service, query(service), body), error => error.status === 422);
});

test("search filters missing rights/images without misreporting upstream totals", () => {
  const body = raw("cma-artwork-search");
  body.data[0].share_license_status = "Copyright";
  body.data[1].images = {};
  const result = normalizeCatalog("cma-artwork-search", query("cma-artwork-search"), body);
  assert.equal(result.returned, 1);
  assert.equal(result.excluded, 2);
  assert.equal(result.total, body.info.total);
});

test("detail rejects an ID mismatch or untrusted image host before caching", () => {
  const body = raw("met-artwork");
  body.objectID = 123;
  assert.throws(() => normalizeCatalog("met-artwork", query("met-artwork"), body));
  body.objectID = 552027; body.primaryImageSmall = "https://evil.test/image.jpg";
  assert.throws(() => normalizeCatalog("met-artwork", query("met-artwork"), body));
});

test("parameter bounds, repeats, URL injection and unknown options fail before acquisition", () => {
  for (const input of ["q=cat&q=dog", "q=", "q=cat&limit=11", "q=cat&offset=1001", "q=cat&limit=1e1", "q=cat&url=https://evil.test", "q=%00cat"]) assert.throws(() => serviceParameters("met-search", new URLSearchParams(input)), error => error.status === 400);
  for (const input of ["id=0", "id=1&id=2", "id=../../secret"]) assert.throws(() => serviceParameters("met-artwork", new URLSearchParams(input)));
  assert.throws(() => serviceParameters("smk-artwork", { id: "https://evil.test" }));
  assert.throws(() => serviceParameters("met-departments", { q: "cat" }));
  for (const inheritedName of ["__proto__", "constructor", "toString"]) assert.throws(() => serviceParameters(inheritedName, {}), error => error.status === 404 && error.message === "Unknown service");
  assert.ok(upstreamUrl("met-search", serviceParameters("met-search", { q: "cat&url=evil" })).includes("q=cat%26url%3Devil"));
});

test("fresh cache reuses validated data and resources never share cache keys", async () => {
  const cache = memoryCache(); let calls = 0;
  const fetcher = async () => { calls++; return Response.json(raw("met-artwork")); };
  const options = { cache, fetcher };
  assert.equal((await catalogResource("met-artwork", query("met-artwork"), options)).cache.status, "miss");
  assert.equal((await catalogResource("met-artwork", query("met-artwork"), options)).cache.status, "hit");
  assert.equal(calls, 1);
  await catalogResource("cma-artwork", query("cma-artwork"), { cache, fetcher: async () => Response.json(raw("cma-artwork")) });
  assert.equal(cache.entries.size, 2);
  assert.ok([...cache.entries.keys()].some(key => key.includes("minicurator-v1/met-artwork")));
});

test("only retained valid data can be returned stale, preserving original retrieval time", async () => {
  const cache = memoryCache(); const clock = Date.now();
  const first = await catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock, fetcher: async () => Response.json(raw("met-artwork")) });
  const stale = await catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock + 2 * 86400000, fetcher: async () => { throw new Error("offline"); } });
  assert.equal(stale.cache.stale, true); assert.equal(stale.cache.status, "stale"); assert.equal(stale.retrievedAt, first.retrievedAt);
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock + (MAX_STALE_SECONDS + 1) * 1000, fetcher: async () => { throw new Error("offline"); } }));
});

test("withdrawn rights and HTTP 404/422 never reuse previously open cached detail", async () => {
  const cache = memoryCache(); const clock = Date.now();
  await catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock, fetcher: async () => Response.json(raw("met-artwork")) });
  const closed = raw("met-artwork"); closed.isPublicDomain = false;
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock + 2 * 86400000, fetcher: async () => Response.json(closed) }), error => error.status === 422);
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock + 2 * 86400000, fetcher: async () => new Response("missing", { status: 404 }) }), error => error.status === 404);
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, now: () => clock + 2 * 86400000, fetcher: async () => new Response("unprocessable", { status: 422 }) }), error => error.status === 422);
});

test("malformed data is never cached and provider rate limit stops uncached fetch", async () => {
  const cache = memoryCache(); let calls = 0;
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, fetcher: async () => Response.json({}) }));
  assert.equal(cache.entries.size, 0);
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, rateLimiter: { limit: async () => ({ success: false }) }, fetcher: async () => { calls++; } }), error => error.status === 429);
  assert.equal(calls, 0);
});

test("provider responses cannot consume unbounded memory and oversized bodies are never cached", async () => {
  const cache = memoryCache();
  const oversized = new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1);
  const body = new ReadableStream({ start(controller) { controller.enqueue(oversized.slice(0, 1024 * 1024)); controller.enqueue(oversized.slice(1024 * 1024)); controller.close(); } });
  await assert.rejects(catalogResource("met-artwork", query("met-artwork"), { cache, fetcher: async () => new Response(body) }), error => error.status === 502 && /size limit/.test(error.message));
  assert.equal(cache.entries.size, 0);
});

test("delivery refuses unmarked stale data, wrong rights and wrong query", () => {
  const r = resource("met-artwork");
  r.retrievedAt = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.throws(() => validateCatalog(r, "met-artwork", query("met-artwork")));
  r.cache = { status: "stale", stale: true }; assert.ok(validateCatalog(r, "met-artwork", query("met-artwork")));
  r.items[0].rights.publicDomain = false; assert.throws(() => validateCatalog(r, "met-artwork", query("met-artwork")));
  assert.throws(() => validateCatalog(resource("met-artwork"), "met-artwork", { id: 1 }));
});
