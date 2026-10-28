import { isAddress } from "viem";
import { NETWORK, USDC, PRICE_ATOMIC } from "../src/app.mjs";

export function validateProbe(record, expectedSeller) {
  const documentation = record["/F-02.md"];
  const health = record["/health"];
  const unpaid = record["/weather?latitude=31.2304&longitude=121.4737"];
  if (documentation?.status !== 200 || health?.status !== 200 || unpaid?.status !== 402) {
    throw new Error("Probe did not meet expected 200/200/402 statuses");
  }
  const config = health.body;
  if (config?.service !== "yoyo-x402-weather" || config.network !== NETWORK || config.asset?.toLowerCase() !== USDC.toLowerCase() || config.priceAtomic !== PRICE_ATOMIC ||
      !isAddress(config.seller) || /^0x0{40}$/i.test(config.seller) || (expectedSeller && config.seller.toLowerCase() !== expectedSeller.toLowerCase())) {
    throw new Error("Health configuration does not match the expected testnet service");
  }
  if (typeof documentation.body !== "string" || documentation.body.includes("{{") ||
      ![record.baseUrl, config.seller, NETWORK, USDC].every(value => documentation.body.includes(value))) {
    throw new Error("F-02 is incomplete or does not match the service configuration");
  }
  const quote = unpaid.paymentRequired;
  if (quote?.x402Version !== 2 || quote.resource?.url !== new URL("/weather?latitude=31.2304&longitude=121.4737", record.baseUrl).href ||
      !quote.accepts?.some(r => r.scheme === "exact" && r.network === NETWORK && r.asset?.toLowerCase() === USDC.toLowerCase() && r.amount === PRICE_ATOMIC && r.payTo?.toLowerCase() === config.seller.toLowerCase())) {
    throw new Error("402 response is missing the expected payment quote");
  }
  for (const entry of [documentation, health, unpaid]) {
    if (!entry.headers["x-request-id"] || !entry.headers["cache-control"]?.includes("no-store")) {
      throw new Error("Service response is missing request tracking or no-store cache controls");
    }
  }
}
