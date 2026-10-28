import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { SERVICES } from "../src/curator-catalog.mjs";
import { NETWORK } from "../src/app.mjs";
import { curatorFetch, curlFetch } from "./curator-transport.mjs";
import { isSafePaymentRequirement } from "../src/x402-policy.mjs";

const { values, positionals } = parseArgs({ options: { resume: { type: "string" } }, allowPositionals: true });
const base = new URL(positionals[0] ?? process.env.CURATOR_SERVER_URL ?? "https://yoyo-x402-minicurator.accessible-trip.workers.dev");
const record = values.resume ? { ...JSON.parse(readFileSync(values.resume, "utf8")), previousProbe: basename(values.resume), resumedAt: new Date().toISOString() } : { startedAt: new Date().toISOString(), baseUrl: base.origin, scope: "Read-only docs, health and unpaid quotes; no authorization signatures", resources: [], errors: [] };
if (record.baseUrl !== base.origin) throw new Error("Cannot resume evidence for another service origin");
mkdirSync("evidence/phase2a", { recursive: true });
const file = `evidence/phase2a/probe-${Date.now()}.json`;
const save = () => writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
async function read(path) {
  const url = new URL(path, base);
  for (let attempt = 0; ; attempt++) {
    try { return await (attempt === 0 ? curatorFetch : curlFetch)(url, { redirect: "error", signal: AbortSignal.timeout(30000) }); }
    catch (error) { record.errors.push({ path, attempt: attempt + 1, transport: attempt === 0 ? "explicit-proxy-fetch" : "curl-read-only-fallback", message: error.message, cause: error.cause?.code }); save(); if (attempt >= 1) throw error; }
  }
}
try {
  const health = await read("/health");
  record.health = { status: health.status, body: await health.json() };
  if (health.status !== 200 || record.health.body.resourceCount !== 9 || record.health.body.network !== NETWORK || record.health.body.seller.toLowerCase() !== process.env.SELLER_ADDRESS?.toLowerCase()) throw new Error("Global health does not match expected seller/network/resources");
  for (const service of Object.values(SERVICES)) {
    if (record.resources.some(item => item.service === service.id && item.passed)) continue;
    const item = { service: service.id };
    const oldIndex = record.resources.findIndex(item => item.service === service.id);
    record.resources[oldIndex < 0 ? record.resources.length : oldIndex] = item;
    const doc = await read(service.documentationPath);
    const document = await doc.text();
    item.documentation = { status: doc.status, sha256: createHash("sha256").update(document).digest("hex"), content: document };
    if (doc.status !== 200 || ![service.id, service.path, process.env.SELLER_ADDRESS, NETWORK].every(marker => marker && document.includes(marker)) || document.includes("{{")) throw new Error(`Invalid F-02: ${service.id}`);
    const resourceHealth = await read(service.healthPath);
    item.health = { status: resourceHealth.status, body: await resourceHealth.json() };
    if (resourceHealth.status !== 200 || item.health.body.id !== service.id || item.health.body.cacheNamespace !== service.cacheNamespace) throw new Error(`Invalid resource health: ${service.id}`);
    const target = new URL(service.path, base);
    target.search = new URLSearchParams(service.example).toString();
    const response = await read(target.href);
    const encodedQuote = response.headers.get("payment-required");
    if (!encodedQuote || encodedQuote.length > 16384) throw new Error(`Missing or oversized payment quote: ${service.id}`);
    const quote = decodePaymentRequiredHeader(encodedQuote);
    item.quote = { status: response.status, headers: Object.fromEntries(response.headers), paymentRequired: quote };
    if (response.status !== 402 || quote.x402Version !== 2 || quote.resource?.url !== target.href || !quote.accepts?.length || response.headers.get("payment-response") || !response.headers.get("cache-control")?.includes("no-store")) throw new Error(`Invalid unpaid response: ${service.id}`);
    if (quote.accepts.some(offer => !isSafePaymentRequirement(offer, process.env.SELLER_ADDRESS))) throw new Error(`Unsafe quote: ${service.id}`);
    item.passed = true;
    save();
    console.log(JSON.stringify({ service: service.id, documentation: 200, health: 200, unpaid: 402 }));
  }
  record.passed = record.resources.length === 9 && record.resources.every(item => item.passed);
  if (record.passed) delete record.error;
} catch (error) { record.passed = false; record.error = error.message; process.exitCode = 1; }
record.completedAt = new Date().toISOString();
save();
console.log(JSON.stringify({ evidence: file, passed: record.passed, resources: record.resources.filter(v => v.passed).length, error: record.error }));
