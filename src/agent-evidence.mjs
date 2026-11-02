// Facilitator failures can echo a signed raw transaction. Never publish these diagnostics.
export function publicEvidence(value) {
  if (Array.isArray(value)) return value.map(publicEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["signature", "payment-signature", "x-payment", "payment-response", "payment-required", "rawtransaction", "token", "tokenhash"].includes(key.toLowerCase())).map(([key, item]) => [key, publicEvidence(item)]));
  if (typeof value === "string" && /eth_sendRawTransaction|transferWithAuthorization|0x[0-9a-f]{130,}|Bearer |sk-[a-z0-9]{16,}/i.test(value)) return /replacement transaction underpriced/i.test(value) ? "Facilitator relayer nonce conflict; signed diagnostics redacted" : "Sensitive upstream diagnostic redacted";
  return value;
}
