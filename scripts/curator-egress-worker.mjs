// Temporary fixed-target probe. It never accepts an arbitrary upstream URL.
export const upstreamProbes = {
  "met-search": "https://collectionapi.metmuseum.org/public/collection/v1.1/search?hasImages=true&q=cat&limit=5&offset=0",
  "met-artwork": "https://collectionapi.metmuseum.org/public/collection/v1/objects/552027",
  "met-departments": "https://collectionapi.metmuseum.org/public/collection/v1/departments",
  "cma-artwork-search": "https://openaccess-api.clevelandart.org/api/artworks/?title=cat&cc0=1&has_image=1&limit=3",
  "cma-artwork": "https://openaccess-api.clevelandart.org/api/artworks/152829",
  "cma-artist-search": "https://openaccess-api.clevelandart.org/api/creators/?name=Min%20Zhen&limit=3",
  "cma-artist": "https://openaccess-api.clevelandart.org/api/creators/31140",
  "smk-search": "https://api.smk.dk/api/v1/art/search/?keys=cat&offset=0&rows=3&lang=en",
  "smk-artwork": "https://api.smk.dk/api/v1/art/?object_number=KMS3402&lang=en",
};

export function validProbePayload(service, body) {
  switch (service) {
    case "met-search": return Number.isInteger(body?.total) && Array.isArray(body.objectIDs);
    case "met-artwork": return body?.objectID === 552027 && body.isPublicDomain === true && !!body.primaryImage;
    case "met-departments": return Array.isArray(body?.departments) && body.departments.length > 0;
    case "cma-artwork-search": return Array.isArray(body?.data) && body.data.some(v => v.id === 152829 && v.share_license_status === "CC0");
    case "cma-artwork": return body?.data?.id === 152829 && body.data.share_license_status === "CC0" && !!body.data.images?.web?.url;
    case "cma-artist-search": return Array.isArray(body?.data) && body.data.some(v => v.id === 31140);
    case "cma-artist": return body?.data?.id === 31140;
    case "smk-search": return Array.isArray(body?.items) && body.items.some(v => v.object_number === "KMS3402" && v.public_domain === true);
    case "smk-artwork": return body?.items?.[0]?.object_number === "KMS3402" && body.items[0].public_domain === true;
    default: return false;
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("GET only", { status: 405 });
    if (url.pathname === "/health") return Response.json({ service: "minicurator-egress-probe", targets: Object.keys(upstreamProbes), environment: "Cloudflare Workers" });
    const service = url.pathname.replace(/^\/probe\//, "");
    const upstream = upstreamProbes[service];
    if (!upstream) return new Response("Unknown fixed probe", { status: 404 });
    const record = { service, upstream, startedAt: new Date().toISOString(), environment: "Cloudflare Workers", colo: request.cf?.colo ?? null };
    const started = Date.now();
    try {
      const response = await fetch(upstream, { redirect: "manual", headers: { Accept: "application/json", "User-Agent": "YoyoMiniCurator/0.1 (+https://github.com/Spartanyoyo/yoyo-x402-weather)" }, signal: AbortSignal.timeout(20000), cf: { cacheTtl: 0 } });
      const text = await response.text();
      record.status = response.status;
      record.contentType = response.headers.get("content-type");
      record.body = JSON.parse(text);
      record.bytes = new TextEncoder().encode(text).length;
      record.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
      record.validPayload = response.ok && validProbePayload(service, record.body);
    } catch (error) {
      record.error = error.message;
      record.validPayload = false;
    }
    record.durationMs = Date.now() - started;
    return Response.json(record, { headers: { "Cache-Control": "no-store" } });
  },
};
