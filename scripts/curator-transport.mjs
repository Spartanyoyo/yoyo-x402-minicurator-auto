import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// curl is a transport fallback for this Windows host. It never retries a request,
// follows a redirect, or places payment signatures in process arguments.
export async function curlFetch(input, init) {
  const request = new Request(input, init);
  if (request.method !== "GET") throw new Error("MiniCurator transport only supports GET");
  const directory = await mkdtemp(join(tmpdir(), "minicurator-http-"));
  const headersFile = join(directory, "headers.txt");
  const bodyFile = join(directory, "body.bin");
  const quote = value => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  try {
    const config = ["silent", "show-error", "http1.1", "max-time = 90", "retry = 0", "max-redirs = 0", ...(process.env.CURATOR_TLS_MAX_VERSION === "TLSv1.2" ? ["tlsv1.2", "tls-max = 1.2"] : []), `url = ${quote(request.url)}`, `dump-header = ${quote(headersFile)}`, `output = ${quote(bodyFile)}`, 'write-out = "%{http_code}"', ...Array.from(request.headers, ([key, value]) => `header = ${quote(`${key}: ${value}`)}`)].join("\n");
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", ["--config", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal: request.signal });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", value => { stdout += value; });
      child.stderr.on("data", value => { stderr += value; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(Number(stdout)) : reject(new Error(`curl transport exited ${code}; ${stderr.trim().replace(/[A-Za-z]:\\[^\r\n]*/g, "[local temporary path]").slice(0, 300)}; no request retry was attempted`)));
      child.stdin.on("error", () => {});
      child.stdin.end(config);
    });
    const raw = await readFile(headersFile, "utf8");
    const block = raw.split(/\r?\n\r?\n/).filter(v => /^HTTP\//.test(v)).at(-1);
    if (!block || !Number.isInteger(status) || status < 200 || status > 599) throw new Error("Invalid curl HTTP response");
    const headers = new Headers();
    for (const line of block.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    return new Response([204, 205, 304].includes(status) ? null : await readFile(bodyFile), { status, headers });
  } finally {
    // Windows scanners can hold a just-written temporary file briefly. Cleanup
    // failure must never discard a received payment receipt or trigger a retry.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const tlsMax = process.env.CURATOR_TLS_MAX_VERSION;
if (tlsMax && !["TLSv1.2", "TLSv1.3"].includes(tlsMax)) throw new Error("CURATOR_TLS_MAX_VERSION must be TLSv1.2 or TLSv1.3");
export const curatorDispatcher = proxy ? new ProxyAgent({ uri: proxy, requestTls: { timeout: 30000, ...(tlsMax ? { maxVersion: tlsMax } : {}) }, proxyTls: { timeout: 30000 }, keepAliveTimeout: 60000, keepAliveMaxTimeout: 60000 }) : undefined;
export async function curatorFetch(input, init) {
  if (process.env.CURATOR_HTTP_TRANSPORT === "curl") return curlFetch(input, init);
  const request = new Request(input, init);
  if (request.method !== "GET") throw new Error("MiniCurator transport only supports GET");
  // Reuse an explicit proxy connection instead of relying on implicit proxy
  // detection or opening a new Windows TLS connection for every paid request.
  return undiciFetch(request.url, { method: "GET", headers: Object.fromEntries(request.headers), redirect: request.redirect, signal: request.signal, ...(curatorDispatcher ? { dispatcher: curatorDispatcher } : {}) });
}
