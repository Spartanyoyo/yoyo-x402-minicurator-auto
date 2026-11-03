import { catalogResource, SERVICES, upstreamUrl } from "./curator-catalog.mjs";
import { sha256, safeError, callKey } from "./agent-contract.mjs";

export const providers = ["Met", "CMA", "SMK"];
export const detailService = { Met: "met-artwork", CMA: "cma-artwork", SMK: "smk-artwork" };
export const searchService = { Met: "met-search", CMA: "cma-artwork-search", SMK: "smk-search" };
export const isDetail = record => record.status === "ok" && SERVICES[record.resourceService]?.kind === "artwork" && record.response?.resource?.items?.length === 1;
export const missingMuseums = records => providers.filter(provider => !records.some(record => isDetail(record) && record.response.resource.provider === provider));

export async function directTool(call, { fetcher = fetch, cache } = {}) {
  const target = new URL(upstreamUrl(call.service, call.parameters));
  if (call.service === "smk-search") target.searchParams.set("filters", "[public_domain:true]");
  const base = { resourceService: call.service, parameters: call.parameters, requestUrl: target.href, access: "direct_free_api", upstreamPaymentAtomic: "0", startedAt: new Date().toISOString() };
  try {
    const resource = await catalogResource(call.service, call.parameters, { fetcher: (_url, init) => fetcher(target.href, init), cache, origin: "https://cloud-curator-v2.internal", skipInvalidSearchItems: true });
    return { ...base, status: "ok", response: { resource }, resourceSha256: sha256(JSON.stringify(resource)), completedAt: new Date().toISOString() };
  } catch (error) {
    const unavailable = [404, 422].includes(error.status) || /Invalid .* (?:image|source) URL/.test(error.message);
    return { ...base, status: unavailable ? "unavailable" : "retryable", httpStatus: unavailable ? error.status === 404 ? 404 : 422 : error.status ?? 502, error: safeError(error), completedAt: new Date().toISOString() };
  }
}

// Deterministic continuation prevents the model from finishing on a filtered
// empty page or retrying an explicitly non-deliverable detail ID.
export function continuationCalls(job, records, remaining) {
  const seen = new Set(job.calls.map(call => call.key));
  const output = [];
  for (const provider of missingMuseums(records)) {
    if (output.length >= Math.min(3, remaining)) break;
    const searches = records.filter(record => record.status === "ok" && record.response?.resource?.provider === provider && ["identifiers", "artwork-search"].includes(record.response.resource.kind)).reverse();
    let next;
    for (const record of searches) {
      const resource = record.response.resource;
      const candidate = resource.items.find(item => !seen.has(callKey({ service: detailService[provider], parameters: { id: provider === "SMK" ? item.id : Number(item.id) } })));
      if (candidate) { next = { service: detailService[provider], parameters: { id: provider === "SMK" ? candidate.id : Number(candidate.id) } }; break; }
    }
    if (!next) for (const record of searches) {
      const { query, total } = record.response.resource;
      const offset = query.offset + query.limit;
      const page = { service: record.resourceService, parameters: { ...query, offset } };
      if (offset < total && offset <= 1000 && !seen.has(callKey(page))) { next = page; break; }
    }
    if (next) { output.push(next); seen.add(callKey(next)); }
  }
  return output;
}
