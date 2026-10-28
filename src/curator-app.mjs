import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isAddress } from "viem";
import { NETWORK, USDC, PRICE_ATOMIC, FACILITATOR } from "./app.mjs";
import { SERVICES, serviceParameters, catalogResource, validateCatalog, CatalogError } from "./curator-catalog.mjs";

export function createCuratorApp({ seller, documentation, fetchResource = catalogResource, facilitator } = {}) {
  if (!isAddress(seller) || /^0x0{40}$/i.test(seller)) throw new Error("A valid nonzero SELLER_ADDRESS is required");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID()); c.header("X-Request-Id", c.get("requestId")); c.header("Cache-Control", "no-store");
    // Bound untrusted input before the SDK's Zod 3 schemas process a payment.
    // The SDK currently requires Zod 3; overriding it to Zod 4 breaks record schemas.
    if (c.req.url.length > 2048) return c.json({ error: "uri_too_long", requestId: c.get("requestId") }, 414);
    if (["payment-signature", "x-payment"].some(name => (c.req.header(name)?.length ?? 0) > 8192)) return c.json({ error: "payment_header_too_large", requestId: c.get("requestId") }, 431);
    await next(); c.header("Cache-Control", "no-store");
  });
  const catalog = origin => Object.values(SERVICES).map(service => ({ ...service, url: `${origin}${service.path}`, documentationUrl: `${origin}${service.documentationPath}`, healthUrl: `${origin}${service.healthPath}`, network: NETWORK, asset: USDC, seller, priceAtomic: PRICE_ATOMIC }));
  app.get("/health", c => c.json({ service: "yoyo-x402-minicurator", network: NETWORK, seller, asset: USDC, priceAtomic: PRICE_ATOMIC, resourceCount: 9, docs: "/F-02.md" }));
  app.get("/catalog", c => c.json({ service: "yoyo-x402-minicurator", resources: catalog(new URL(c.req.url).origin) }));
  for (const path of ["/", "/F-02.md", "/llms.txt"]) app.get(path, c => c.text(documentation.replaceAll("{{BASE_URL}}", new URL(c.req.url).origin).replaceAll("{{SELLER_ADDRESS}}", seller)));
  for (const service of Object.values(SERVICES)) {
    app.get(service.healthPath, c => c.json({ ...service, network: NETWORK, asset: USDC, seller, priceAtomic: PRICE_ATOMIC, upstreamProbedByHealth: false }));
    app.get(service.documentationPath, c => {
      const origin = new URL(c.req.url).origin;
      const query = new URLSearchParams(service.example).toString();
      return c.text([`# F-02: ${service.id}`, "", service.description, "", "```json", JSON.stringify({ ...service, url: `${origin}${service.path}`, exampleUrl: `${origin}${service.path}${query ? `?${query}` : ""}`, network: NETWORK, asset: USDC, seller, priceAtomic: PRICE_ATOMIC, scheme: "exact", x402Version: 2, maxTimeoutSeconds: 300 }, null, 2), "```", "", "GET only. Parameters occur once; unknown parameters are rejected. q: 1..80 characters; limit: 1..10 (default 5); offset: 0..1000 (default 0). Detail requires id. met-search additionally accepts departmentId. met-departments accepts no query parameters.", "", "Unpaid: 402 + PAYMENT-REQUIRED. Paid success: 200 + PAYMENT-RESPONSE + X-Request-Id. Result envelope: {requestId, resource}. resource contains service, provider, kind, query, sourceUrl, retrievedAt, total, returned, excluded, items, cache. Search totals include excluded records; returned is the actual delivered count.", "", "Met search IDs and artist artwork references have rightsVerified=false; purchase artwork detail before displaying an image. Artwork resources only deliver explicitly CC0/public-domain works with HTTPS museum image/source URLs. Empty filtered search results are valid and still cost one call. Missing/closed/malformed detail returns an error before settlement.", "", `Cache namespace: ${service.cacheNamespace}. Fresh: ${service.freshSeconds}s; maximum retained age: 7 days. Stale fallback explicitly carries cache.stale=true and original retrievedAt. No image binaries are proxied. Provider JSON responses are streamed and rejected above 2 MiB.`, "", "One signature and one paid submission per purchase. Never automatically repeat an unknown payment outcome. Inspect authorization, settlement and chain evidence first.", "", `Full service documentation: ${origin}/F-02.md`, ""].join("\n"));
    });
    app.use(service.path, async (c, next) => {
      if (c.req.method !== "GET") { c.header("Allow", "GET"); return c.json({ error: "method_not_allowed", requestId: c.get("requestId") }, 405); }
      try { c.set("parameters", serviceParameters(service.id, new URL(c.req.url).searchParams)); }
      catch (error) { return c.json({ error: "invalid_parameters", message: error.message, requestId: c.get("requestId") }, 400); }
      await next();
    });
  }
  const resourceServer = new x402ResourceServer(facilitator ?? new HTTPFacilitatorClient({ url: FACILITATOR })).register(NETWORK, new ExactEvmScheme());
  app.use(paymentMiddleware(Object.fromEntries(Object.values(SERVICES).map(service => [`GET ${service.path}`, { accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: seller }], description: service.description, mimeType: "application/json" }])), resourceServer));
  for (const service of Object.values(SERVICES)) app.get(service.path, async c => {
    try {
      const query = c.get("parameters");
      const resource = await fetchResource(service.id, query, { cache: c.env?.CATALOG_CACHE, origin: new URL(c.req.url).origin, rateLimiter: c.env?.UPSTREAM_RATE_LIMITER });
      validateCatalog(resource, service.id, query);
      if (!resource.cache) throw new CatalogError("Missing cache metadata");
      return c.json({ requestId: c.get("requestId"), resource });
    } catch (error) { return c.json({ error: "catalog_unavailable", message: error.message, requestId: c.get("requestId") }, error instanceof CatalogError ? error.status : 502); }
  });
  app.onError((error, c) => c.json({ error: "service_error", message: error.message, requestId: c.get("requestId") }, 503));
  return app;
}
