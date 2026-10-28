import { readFileSync } from "node:fs";
import { normalizeCatalog, SERVICES, serviceParameters } from "../src/curator-catalog.mjs";

// Real read-only museum payloads captured by Cloudflare. These are fixtures,
// not live calls or payment evidence for the tests below.
const probe = JSON.parse(readFileSync(new URL("../evidence/phase2a/cloudflare-egress-2026-10-25.json", import.meta.url), "utf8"));
export function raw(service) { return structuredClone(probe.records.find(record => record.service === service && record.clientValidated).body); }
export function query(service) { return serviceParameters(service, SERVICES[service].example); }
export function resource(service) { return { ...normalizeCatalog(service, query(service), raw(service)), cache: { status: "miss", stale: false } }; }
export function memoryCache() {
  const entries = new Map();
  return { entries, async match(request) { return entries.get(request.url)?.clone(); }, async put(request, response) { entries.set(request.url, response.clone()); } };
}
