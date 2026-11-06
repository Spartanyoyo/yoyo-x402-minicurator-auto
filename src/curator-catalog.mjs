const definitions = [
  ["met-search", "Met", "identifiers", { q: "cat", limit: "5", offset: "0" }, "Search Met object IDs; rights require the separate artwork resource"],
  ["met-artwork", "Met", "artwork", { id: "552027" }, "One public-domain Met artwork with image and provenance"],
  ["met-departments", "Met", "departments", {}, "Met department identifiers and names"],
  ["cma-artwork-search", "CMA", "artwork-search", { q: "cat", limit: "3", offset: "0" }, "Search CMA titles; only CC0 records with images"],
  ["cma-artwork", "CMA", "artwork", { id: "152829" }, "One CC0 Cleveland artwork with image and provenance"],
  ["cma-artist-search", "CMA", "artist-search", { q: "Min Zhen", limit: "3", offset: "0" }, "Search CMA artist names and related artwork IDs"],
  ["cma-artist", "CMA", "artist", { id: "31140" }, "One CMA artist and related artwork references"],
  ["smk-search", "SMK", "artwork-search", { q: "cat", limit: "3", offset: "0" }, "Search SMK; only public-domain records with images"],
  ["smk-artwork", "SMK", "artwork", { id: "KMS3402" }, "One public-domain SMK artwork with image and provenance"],
];

export const SERVICES = Object.freeze(Object.fromEntries(definitions.map(([id, provider, kind, example, description]) => [id, Object.freeze({ id, provider, kind, example, description, path: `/api/${id}`, documentationPath: `/services/${id}/F-02.md`, healthPath: `/services/${id}/health`, cacheNamespace: `minicurator-v1/${id}`, freshSeconds: kind.includes("search") || kind === "identifiers" ? 3600 : 86400 })])));
export const MAX_STALE_SECONDS = 7 * 86400;
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const CC0 = "https://creativecommons.org/publicdomain/zero/1.0/";
export const PUBLIC_DOMAIN = "https://creativecommons.org/publicdomain/mark/1.0/";

export class CatalogError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function integer(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new CatalogError(`${name} must be an integer in ${min}..${max}`, 400);
  return Number(value);
}

function serviceDefinition(service) {
  return Object.hasOwn(SERVICES, service) ? SERVICES[service] : null;
}

export function serviceParameters(service, input) {
  const definition = serviceDefinition(service);
  if (!definition) throw new CatalogError("Unknown service", 404);
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input);
  const search = "q" in definition.example;
  const allowed = new Set(search ? ["q", "limit", "offset", ...(service === "met-search" ? ["departmentId"] : [])] : service === "met-departments" ? [] : ["id"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new CatalogError(`Unknown or repeated parameter: ${key}`, 400);
  if (search) {
    const q = params.get("q")?.trim();
    if (!q || q.length > 80 || /[\x00-\x1f\x7f]/.test(q)) throw new CatalogError("q must contain 1..80 characters without control characters", 400);
    const normalized = { q, limit: integer(params.get("limit") ?? undefined, "limit", 5, 1, 10), offset: integer(params.get("offset") ?? undefined, "offset", 0, 0, 1000) };
    if (params.has("departmentId")) normalized.departmentId = integer(params.get("departmentId"), "departmentId", undefined, 1, 1000);
    return normalized;
  }
  if (service === "met-departments") return {};
  const id = params.get("id");
  if (service === "smk-artwork") {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new CatalogError("id must be a valid SMK object number", 400);
    return { id };
  }
  return { id: integer(id ?? "", "id", undefined, 1, 999999999) };
}

export function upstreamUrl(service, params) {
  let url;
  switch (service) {
    case "met-search":
      url = new URL("https://collectionapi.metmuseum.org/public/collection/v1.1/search");
      url.search = new URLSearchParams({ hasImages: "true", q: params.q, limit: String(params.limit), offset: String(params.offset), ...(params.departmentId ? { departmentId: String(params.departmentId) } : {}) }).toString(); break;
    case "met-artwork": url = new URL(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${params.id}`); break;
    case "met-departments": url = new URL("https://collectionapi.metmuseum.org/public/collection/v1/departments"); break;
    case "cma-artwork-search": url = new URL("https://openaccess-api.clevelandart.org/api/artworks/"); url.search = new URLSearchParams({ title: params.q, cc0: "1", has_image: "1", limit: String(params.limit), skip: String(params.offset) }).toString(); break;
    case "cma-artwork": url = new URL(`https://openaccess-api.clevelandart.org/api/artworks/${params.id}`); break;
    case "cma-artist-search": url = new URL("https://openaccess-api.clevelandart.org/api/creators/"); url.search = new URLSearchParams({ name: params.q, limit: String(params.limit), skip: String(params.offset) }).toString(); break;
    case "cma-artist": url = new URL(`https://openaccess-api.clevelandart.org/api/creators/${params.id}`); break;
    case "smk-search": url = new URL("https://api.smk.dk/api/v1/art/search/"); url.search = new URLSearchParams({ keys: params.q, offset: String(params.offset), rows: String(params.limit), lang: "en" }).toString(); break;
    case "smk-artwork": url = new URL("https://api.smk.dk/api/v1/art/"); url.search = new URLSearchParams({ object_number: params.id, lang: "en" }).toString(); break;
    default: throw new CatalogError("Unknown service", 404);
  }
  return url.href;
}

const hosts = {
  Met: { source: ["www.metmuseum.org", "metmuseum.org"], image: ["images.metmuseum.org"] },
  CMA: { source: ["www.clevelandart.org", "clevelandart.org"], image: ["openaccess-cdn.clevelandart.org"] },
  SMK: { source: ["open.smk.dk"], image: ["iip-thumb.smk.dk", "iip.smk.dk", "api.smk.dk"] },
};

function safeUrl(value, provider, type) {
  try {
    const url = new URL(value);
    if (provider === "SMK" && type === "image" && url.hostname === "api.smk.dk" && (!/^\/api\/v1\/thumbnail\/[a-f0-9-]+\.(?:jpg|jpeg|png)$/i.test(url.pathname) || url.search || url.hash)) throw new Error("Invalid official thumbnail path");
    if (url.protocol === "https:" && !url.username && !url.password && hosts[provider][type].includes(url.hostname)) return url.href;
  } catch {}
  throw new CatalogError(`Invalid ${provider} ${type} URL`);
}

const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const texts = value => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
const expect = (condition, message) => { if (!condition) throw new CatalogError(message); };

function artwork(provider, item) {
  expect(item && typeof item === "object", "Missing artwork object");
  const open = provider === "Met" ? item.isPublicDomain === true : provider === "CMA" ? item.share_license_status === "CC0" : item.public_domain === true;
  if (!open) throw new CatalogError("Artwork lacks an explicit public-domain/CC0 flag", 422);
  const result = {
    museum: provider,
    id: String(provider === "Met" ? item.objectID : provider === "CMA" ? item.id : item.object_number),
    title: text(provider === "SMK" ? item.titles?.find(v => v.language === "engelsk")?.title ?? item.titles?.[0]?.title : item.title),
    artists: provider === "Met" ? (item.artistDisplayName ? [{ id: null, name: item.artistDisplayName }] : []) : provider === "CMA" ? (item.creators ?? []).map(v => ({ id: String(v.id), name: v.description })) : texts(item.artist).map(name => ({ id: null, name })),
    date: text(provider === "Met" ? item.objectDate : provider === "CMA" ? item.creation_date : item.production_date?.[0]?.period),
    medium: texts(provider === "Met" ? item.medium : provider === "CMA" ? item.technique : item.techniques ?? item.materials),
    culture: texts(item.culture),
    department: text(item.department),
    imageUrl: safeUrl(provider === "Met" ? item.primaryImageSmall || item.primaryImage : provider === "CMA" ? item.images?.web?.url : item.image_thumbnail, provider, "image"),
    sourceUrl: safeUrl(provider === "Met" ? item.objectURL : provider === "CMA" ? item.url : item.frontend_url, provider, "source"),
    rights: { publicDomain: true, licenseUrl: provider === "SMK" ? PUBLIC_DOMAIN : CC0, evidence: provider === "Met" ? "isPublicDomain=true" : provider === "CMA" ? 'share_license_status="CC0"' : "public_domain=true" },
  };
  expect(result.title && result.id !== "undefined", "Artwork has no valid ID/title");
  expect(provider === "SMK" ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result.id) : /^[1-9]\d*$/.test(result.id), "Invalid artwork ID");
  return result;
}

function artist(item) {
  expect(Number.isSafeInteger(item?.id) && item.id > 0 && text(item.name) && Array.isArray(item.artworks), "Invalid artist record");
  return { id: String(item.id), name: item.name, description: text(item.description), nationality: text(item.nationality), birthYear: text(item.birth_year), deathYear: text(item.death_year), biography: text(item.biography), artworks: item.artworks.map(v => {
    expect(Number.isSafeInteger(v.id) && v.id > 0 && text(v.title), "Invalid related artwork");
    return { id: String(v.id), title: v.title, sourceUrl: safeUrl(v.url, "CMA", "source"), rightsVerified: false };
  }) };
}

export function normalizeCatalog(service, query, body, retrievedAt = new Date().toISOString(), { skipInvalidSearchItems = false } = {}) {
  const definition = serviceDefinition(service);
  expect(definition && body && typeof body === "object", "Missing provider payload");
  let items;
  let total = null;
  let excluded = 0;
  if (service === "met-search") {
    expect(Number.isSafeInteger(body.total) && body.total >= 0 && (Array.isArray(body.objectIDs) || (body.total === 0 && body.objectIDs === null)), "Invalid Met search response");
    items = (body.objectIDs ?? []).slice(0, query.limit).map(id => { expect(Number.isSafeInteger(id) && id > 0, "Invalid Met object ID"); return { id: String(id), rightsVerified: false }; });
    total = body.total;
  } else if (service === "met-departments") {
    expect(Array.isArray(body.departments) && body.departments.length > 0, "Invalid departments response");
    items = body.departments.map(v => { expect(Number.isSafeInteger(v.departmentId) && v.departmentId > 0 && text(v.displayName), "Invalid department"); return { id: String(v.departmentId), name: v.displayName }; });
    total = items.length;
  } else if (definition.kind === "artwork") {
    const item = service === "met-artwork" ? body : service === "cma-artwork" ? body.data : body.items?.[0];
    items = [artwork(definition.provider, item)];
    expect(items[0].id === String(query.id), "Provider returned a different artwork");
    total = 1;
  } else if (definition.kind === "artwork-search") {
    const candidates = definition.provider === "CMA" ? body.data : body.items;
    expect(Array.isArray(candidates), "Invalid artwork search response");
    total = definition.provider === "CMA" ? body.info?.total : body.found;
    expect(Number.isSafeInteger(total) && total >= 0, "Invalid search total");
    items = [];
    for (const item of candidates.slice(0, query.limit)) {
      const explicitlyOpen = definition.provider === "CMA" ? item?.share_license_status === "CC0" : item?.public_domain === true;
      const hasImage = definition.provider === "CMA" ? !!item?.images?.web?.url : !!item?.image_thumbnail;
      if (!explicitlyOpen || !hasImage) { excluded++; continue; }
      try { items.push(artwork(definition.provider, item)); }
      catch (error) { if (!skipInvalidSearchItems) throw error; excluded++; }
    }
  } else if (definition.kind === "artist-search") {
    expect(Array.isArray(body.data) && Number.isSafeInteger(body.info?.total) && body.info.total >= 0, "Invalid artist search response");
    items = body.data.slice(0, query.limit).map(artist);
    total = body.info.total;
  } else {
    items = [artist(body.data)];
    expect(items[0].id === String(query.id), "Provider returned a different artist");
    total = 1;
  }
  return { schemaVersion: 1, service, provider: definition.provider, kind: definition.kind, query, sourceUrl: upstreamUrl(service, query), retrievedAt, total, returned: items.length, excluded, items };
}

export function validateCatalog(result, service, query, now = Date.now()) {
  const definition = serviceDefinition(service);
  expect(definition && result?.schemaVersion === 1 && result.service === service && result.provider === definition.provider && result.kind === definition.kind, "Wrong catalog service/schema");
  expect(JSON.stringify(result.query) === JSON.stringify(query) && result.sourceUrl === upstreamUrl(service, query), "Catalog query/source mismatch");
  const age = now - Date.parse(result.retrievedAt);
  expect(Number.isFinite(age) && age >= -300000 && age <= MAX_STALE_SECONDS * 1000, "Invalid or expired catalog timestamp");
  expect(Array.isArray(result.items) && result.returned === result.items.length && Number.isSafeInteger(result.total) && result.total >= 0 && Number.isSafeInteger(result.excluded) && result.excluded >= 0, "Invalid catalog result counts");
  if ("limit" in query) expect(result.items.length <= query.limit, "Result exceeds purchased limit");
  if (["artwork", "artist"].includes(definition.kind)) expect(result.items.length === 1 && result.items[0].id === String(query.id), "Detail response ID mismatch");
  for (const item of result.items) {
    expect(typeof item.id === "string" && item.id.length > 0, "Missing catalog item ID");
    if (["artwork", "artwork-search"].includes(definition.kind)) {
      expect(text(item.title) && Array.isArray(item.artists) && Array.isArray(item.medium) && Array.isArray(item.culture), "Invalid artwork metadata");
      expect(item.rights?.publicDomain === true && item.rights.licenseUrl === (definition.provider === "SMK" ? PUBLIC_DOMAIN : CC0), "Artwork rights not verified");
      safeUrl(item.imageUrl, definition.provider, "image"); safeUrl(item.sourceUrl, definition.provider, "source");
    } else if (definition.kind === "identifiers") expect(item.rightsVerified === false && /^[1-9]\d*$/.test(item.id), "Search IDs must not claim image rights");
    else if (definition.kind === "departments") expect(text(item.name), "Invalid department name");
    else {
      expect(text(item.name) && Array.isArray(item.artworks), "Invalid artist delivery");
      for (const work of item.artworks) { expect(/^[1-9]\d*$/.test(work.id) && text(work.title) && work.rightsVerified === false, "Invalid artist artwork reference"); safeUrl(work.sourceUrl, "CMA", "source"); }
    }
  }
  if (result.cache) {
    expect(typeof result.cache.stale === "boolean" && ["miss", "hit", "stale"].includes(result.cache.status), "Missing cache status");
    expect(result.cache.stale === (result.cache.status === "stale"), "Inconsistent stale status");
    if (!result.cache.stale) expect(age <= definition.freshSeconds * 1000 + 300000, "Old catalog result is missing stale=true");
  }
  return result;
}

async function providerJson(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new CatalogError("Museum provider response exceeds the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CatalogError("Museum provider returned an empty response");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CatalogError("Museum provider response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CatalogError("Museum provider returned invalid JSON"); }
}

export async function catalogResource(service, query, { fetcher = fetch, cache, origin = "https://minicurator.invalid", rateLimiter, now = () => Date.now(), skipInvalidSearchItems = false } = {}) {
  const definition = serviceDefinition(service);
  if (!definition) throw new CatalogError("Unknown service", 404);
  const key = new Request(`${origin}/__cache/${definition.cacheNamespace}?${new URLSearchParams(query)}`);
  let previous;
  try {
    const response = await cache?.match(key);
    if (response) previous = validateCatalog(await response.json(), service, query, now());
  } catch { previous = undefined; }
  const age = previous ? now() - Date.parse(previous.retrievedAt) : Infinity;
  if (age <= definition.freshSeconds * 1000) return { ...previous, cache: { status: "hit", stale: false } };
  try {
    if (rateLimiter && !(await rateLimiter.limit({ key: definition.provider })).success) throw new CatalogError("Provider request budget exceeded; use cached results or retry later", 429);
    const response = await fetcher(upstreamUrl(service, query), { redirect: "manual", headers: { Accept: "application/json", "User-Agent": "YoyoMiniCurator/0.1 (+https://github.com/Spartanyoyo/yoyo-x402-weather)" }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new CatalogError(`Museum provider returned HTTP ${response.status}`, [404, 422].includes(response.status) ? response.status : 502);
    const result = validateCatalog(normalizeCatalog(service, query, await providerJson(response), new Date(now()).toISOString(), { skipInvalidSearchItems }), service, query, now());
    // Only validated data is cached. Paid response envelopes/receipts are never cached.
    let cacheWriteFailed = false;
    try { await cache?.put(key, Response.json(result, { headers: { "Cache-Control": `public, max-age=${MAX_STALE_SECONDS}` } })); }
    catch { cacheWriteFailed = true; }
    return { ...result, cache: { status: "miss", stale: false, ...(cacheWriteFailed ? { writeFailed: true } : {}) } };
  } catch (error) {
    if (previous && ![404, 422].includes(error.status)) return { ...previous, cache: { status: "stale", stale: true, reason: "upstream_unavailable" } };
    throw error instanceof CatalogError ? error : new CatalogError("Museum request failed or returned invalid JSON");
  }
}
