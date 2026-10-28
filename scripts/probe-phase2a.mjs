import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const userAgent = "yoyo-phase2a-feasibility/1.0 (+https://github.com/Spartanyoyo/yoyo-x402-weather)";
const calls = [
  {
    name: "deps-package",
    method: "GET",
    url: "https://api.deps.dev/v3/systems/npm/packages/express",
    summarize: (v) => ({ versions: v.versions?.length ?? null }),
  },
  {
    name: "deps-version",
    method: "GET",
    url: "https://api.deps.dev/v3/systems/npm/packages/express/versions/4.21.2",
    summarize: (v) => ({ package: v.versionKey, publishedAt: v.publishedAt, licenses: v.licenses }),
  },
  {
    name: "deps-requirements",
    method: "GET",
    url: "https://api.deps.dev/v3/systems/npm/packages/express/versions/4.21.2:requirements",
    summarize: (v) => ({ npmRequirements: v.npm?.dependencies?.dependencies?.length ?? null, devRequirements: v.npm?.dependencies?.devDependencies?.length ?? null }),
  },
  {
    name: "deps-dependencies",
    method: "GET",
    url: "https://api.deps.dev/v3/systems/npm/packages/express/versions/4.21.2:dependencies",
    summarize: (v) => ({ nodes: v.nodes?.length ?? null, edges: v.edges?.length ?? null }),
  },
  {
    name: "deps-project-health",
    method: "GET",
    url: "https://api.deps.dev/v3/projects/github.com%2Fexpressjs%2Fexpress",
    summarize: (v) => ({ project: v.projectKey?.id, scorecardChecks: v.scorecard?.checks?.length ?? null }),
  },
  {
    name: "deps-advisory",
    method: "GET",
    url: "https://api.deps.dev/v3/advisories/GHSA-29mw-wpgm-hmr9",
    summarize: (v) => ({ id: v.advisoryKey?.id, title: v.title, aliases: v.aliases, cvss3Score: v.cvss3Score }),
  },
  {
    name: "osv-query",
    method: "POST",
    url: "https://api.osv.dev/v1/query",
    body: { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.20" },
    summarize: (v) => ({ vulnerabilities: v.vulns?.length ?? 0, firstId: v.vulns?.[0]?.id ?? null }),
  },
  {
    name: "osv-vulnerability-detail",
    method: "GET",
    url: "https://api.osv.dev/v1/vulns/GHSA-29mw-wpgm-hmr9",
    summarize: (v) => ({ id: v.id, summary: v.summary, aliases: v.aliases }),
  },
];

async function request(call) {
  const started = performance.now();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(call.url, {
        method: call.method,
        headers: {
          "User-Agent": userAgent,
          "Accept": "application/json",
          ...(call.body ? { "Content-Type": "application/json" } : {}),
        },
        body: call.body ? JSON.stringify(call.body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      let value;
      try { value = JSON.parse(text); } catch { value = null; }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      return {
        name: call.name,
        method: call.method,
        url: call.url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        attempts: attempt,
        latencyMs: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        summary: call.summarize(value),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw new Error(`${call.name} failed after 3 attempts: ${lastError?.message ?? lastError}`);
}

const probes = [];
for (const call of calls) probes.push(await request(call));

const artifact = {
  generatedAt: new Date().toISOString(),
  purpose: "Phase 2A dependency-sentinel feasibility and live upstream connectivity check",
  scope: "Read-only probes; no x402 payment and no deployment",
  network: "Authenticated desktop environment, outbound HTTPS",
  sources: [
    {
      name: "deps.dev API v3",
      documentation: "https://docs.deps.dev/api/v3/",
      access: "Public API; examples require no API key. Official docs allow client caching.",
      observedRisk: "No formally specified rate limit; servers may return HTTP 429 under load.",
    },
    {
      name: "OSV API",
      documentation: "https://google.github.io/osv.dev/api/",
      access: "Public API; no authentication described.",
      observedRisk: "Official docs currently state no rate limits; HTTP/1.1 responses are capped at 32 MiB.",
    },
  ],
  probes,
  assessment: {
    allProbesPassed: probes.every((probe) => probe.status === 200),
    successfulProbes: probes.length,
  },
};

await mkdir("evidence/phase2a", { recursive: true });
const output = "evidence/phase2a/dependency-sentinel-upstream-probe-2026-10-23.json";
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(output);
console.table(probes.map(({ name, status, attempts, latencyMs, bytes }) => ({ name, status, attempts, latencyMs, bytes })));

