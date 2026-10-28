import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isAddress } from "viem";
import { coordinates, weatherAt } from "./weather.mjs";

export const NETWORK = "eip155:84532";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PRICE_ATOMIC = "1000";
export const FACILITATOR = "https://x402.org/facilitator";

export function createApp({ seller, documentation, fetchWeather = weatherAt, facilitator } = {}) {
  if (!isAddress(seller) || /^0x0{40}$/i.test(seller)) throw new Error("A valid nonzero SELLER_ADDRESS is required");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.get("/health", c => c.json({ service: "yoyo-x402-weather", network: NETWORK, seller, asset: USDC, priceAtomic: PRICE_ATOMIC, docs: "/F-02.md" }));
  for (const path of ["/F-02.md", "/llms.txt"]) {
    app.get(path, c => c.text(documentation.replaceAll("{{BASE_URL}}", new URL(c.req.url).origin).replaceAll("{{SELLER_ADDRESS}}", seller)));
  }
  app.use("/weather", async (c, next) => {
    if (c.req.method !== "GET") {
      c.header("Allow", "GET");
      return c.json({ error: "method_not_allowed", requestId: c.get("requestId") }, 405);
    }
    try {
      const query = c.req.queries();
      if (query.latitude?.length !== 1 || query.longitude?.length !== 1) {
        throw new Error("latitude and longitude must each occur exactly once");
      }
      c.set("location", coordinates(c.req.query()));
    }
    catch (error) { return c.json({ error: "invalid_parameters", message: error.message }, 400); }
    await next();
  });
  const resourceServer = new x402ResourceServer(facilitator ?? new HTTPFacilitatorClient({ url: FACILITATOR }))
    .register(NETWORK, new ExactEvmScheme());
  app.use(paymentMiddleware({
    "GET /weather": {
      accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: seller }],
      description: "Weather model forecast for the requested coordinates, from MET Norway",
      mimeType: "application/json",
    },
  }, resourceServer));
  app.get("/weather", async c => {
    try {
      const weather = await fetchWeather(c.get("location"));
      return c.json({ requestId: c.get("requestId"), weather });
    } catch (error) {
      return c.json({ requestId: c.get("requestId"), error: "upstream_weather_error", message: error.message }, 502);
    }
  });
  app.onError((error, c) => c.json({ error: "service_error", message: error.message, requestId: c.get("requestId") }, 503));
  return app;
}
