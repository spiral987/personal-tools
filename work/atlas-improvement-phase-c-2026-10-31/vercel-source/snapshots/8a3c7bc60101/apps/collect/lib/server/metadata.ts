import https, { type RequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";

export const METADATA_LIMITS = Object.freeze({ bytes: 256 * 1024, timeoutMs: 8000, redirects: 3, requestBytes: 16 * 1024 });
const ERRORS = {
  unsafe: "このURLからはページ情報を取得できません。収集したURLとメモは残っています。",
  unavailable: "ページ情報を取得できませんでした。収集したURLとメモは残っています。",
  too_large: "ページ情報が大きすぎるため、取得を中止しました。収集したURLとメモは残っています。",
  timeout: "ページ情報の取得が時間切れになりました。あとで再試行できます。",
  unsupported: "このページの形式には対応していません。タイトルは手入力できます。",
} as const;
export class MetadataError extends Error {
  readonly code: keyof typeof ERRORS;
  constructor(code: keyof typeof ERRORS) { super(ERRORS[code]); this.name = "MetadataError"; this.code = code; }
}
export type PageMetadata = { title: string; description: string; siteName: string; finalUrl: string };
export type ResolvedAddress = { address: string; family: number };
export type ValidatedTarget = { url: URL; address: string; family: 4 | 6 };
export type MetadataHop = { status: number; location?: string; contentType?: string; body: Uint8Array };
export type MetadataDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (target: ValidatedTarget, signal: AbortSignal) => Promise<MetadataHop>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** Only DNS names are eligible. Stored resources may use other URLs, but those are never fetched.
 * URL canonicalization rejects alternate numeric IPv4 spellings before DNS is considered.
 */
export function validateMetadataUrl(input: unknown): URL {
  if (typeof input !== "string" || input.length > 8192) throw new MetadataError("unsafe");
  const trimmed = input.trim();
  if (!trimmed || /[\u0000-\u0020\u007f]/u.test(trimmed)) throw new MetadataError("unsafe");
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new MetadataError("unsafe"); }
  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password ||
      !hostname.includes(".") || hostname.length > 253 || isIP(hostname.replace(/^\[|\]$/g, "")) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/u.test(hostname) ||
      !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new MetadataError("unsafe");
  }
  url.hostname = hostname; url.hash = "";
  return url;
}

/** ipaddr.js classifies IANA special-use ranges; IPv6 additionally requires global unicast.
 * Mapped IPv4, NAT64, transition tunnels, local, multicast and reserved answers are all denied.
 * https://github.com/whitequark/ipaddr.js/tree/v2.3.0
 */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== "unicast") return false;
    return parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3);
  } catch { return false; }
}

function aborted(signal: AbortSignal): void { if (signal.aborted) throw new MetadataError("timeout"); }
async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  aborted(signal);
  let rejectAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new MetadataError("timeout"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener("abort", rejectAbort); }
}

export async function resolveMetadataTarget(url: URL, resolve: NonNullable<MetadataDependencies["resolve"]>, signal: AbortSignal): Promise<ValidatedTarget> {
  const answers = await withinDeadline(resolve(url.hostname), signal);
  if (!Array.isArray(answers) || !answers.length || answers.length > 64 ||
      answers.some(answer => !isPublicAddress(answer.address) || isIP(answer.address) !== answer.family)) {
    throw new MetadataError("unsafe");
  }
  const selected = answers.find(answer => answer.family === 4) ?? answers[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

/** Keep TLS hostname verification and SNI on the validated DNS name, while lookup can return
 * only the already-vetted address. No second DNS lookup or proxy environment is involved.
 * https://nodejs.org/docs/latest-v24.x/api/https.html#httpsrequestoptions-callback
 */
export function pinnedRequestOptions(target: ValidatedTarget, signal: AbortSignal): RequestOptions {
  if (!isPublicAddress(target.address) || isIP(target.address) !== target.family) throw new MetadataError("unsafe");
  return {
    protocol: "https:", hostname: target.url.hostname, port: 443, servername: target.url.hostname,
    method: "GET", path: target.url.pathname + target.url.search, family: target.family,
    agent: false, rejectUnauthorized: true, signal,
    lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    headers: { Accept: "text/html, application/xhtml+xml", "Accept-Encoding": "identity", "User-Agent": "PersonalTools-Collect/1.0" },
  };
}

export function requestPinnedMetadata(target: ValidatedTarget, signal: AbortSignal, requestImpl: typeof https.request = https.request): Promise<MetadataHop> {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const req = requestImpl(pinnedRequestOptions(target, signal), response => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy(); resolve({ status, location, body: new Uint8Array() }); return;
      }
      if (status < 200 || status >= 300) { response.destroy(); reject(new MetadataError("unavailable")); return; }
      const contentType = response.headers["content-type"] ?? "";
      const encoding = response.headers["content-encoding"];
      if ((encoding && encoding.toLowerCase() !== "identity") || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/iu.test(contentType)) {
        response.destroy(); reject(new MetadataError("unsupported")); return;
      }
      const length = response.headers["content-length"];
      if (length && (!/^\d+$/u.test(length) || Number(length) > METADATA_LIMITS.bytes)) {
        response.destroy(); reject(new MetadataError("too_large")); return;
      }
      let received = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > METADATA_LIMITS.bytes) { response.destroy(); req.destroy(); reject(new MetadataError("too_large")); }
        else chunks.push(chunk);
      });
      response.once("end", () => resolve({ status, contentType, body: Buffer.concat(chunks, received) }));
      response.once("aborted", () => reject(new MetadataError("unavailable")));
      response.once("error", () => reject(new MetadataError(signal.aborted ? "timeout" : "unavailable")));
    });
    req.once("error", () => reject(new MetadataError(signal.aborted ? "timeout" : "unavailable")));
    req.end();
  });
}

function cleanText(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  let result = "";
  // Match the shared model's UTF-16 length budget without cutting a surrogate pair.
  for (const point of normalized) { if (result.length + point.length > limit) break; result += point; }
  return result;
}
export function parsePageMetadata(bytes: Uint8Array, contentType = "", finalUrl = ""): PageMetadata {
  if (bytes.byteLength > METADATA_LIMITS.bytes) throw new MetadataError("too_large");
  const charset = /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/iu.exec(contentType)?.[1] ?? "utf-8";
  let html: string;
  try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder().decode(bytes); }
  let title = "", ogTitle = "", description = "", ogDescription = "", siteName = "", inTitle = false;
  // Parse inert text only. We never execute, render or fetch embedded markup/og:image.
  // https://github.com/fb55/htmlparser2/tree/v10.0.0
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "title") inTitle = true;
      if (name !== "meta") return;
      const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
      const value = attributes.content ?? "";
      if (key === "og:title" && !ogTitle) ogTitle = value;
      if (key === "og:description" && !ogDescription) ogDescription = value;
      if (key === "description" && !description) description = value;
      if (key === "og:site_name" && !siteName) siteName = value;
    },
    ontext(value) { if (inTitle) title += value; },
    onclosetag(name) { if (name === "title") inTitle = false; },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  return { title: cleanText(ogTitle || title, 300), description: cleanText(ogDescription || description, 2000), siteName: cleanText(siteName, 100), finalUrl };
}

export async function fetchPageMetadata(input: unknown, dependencies: MetadataDependencies = {}): Promise<PageMetadata> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (dependencies.signal?.aborted) controller.abort();
  else dependencies.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = Math.min(Math.max(dependencies.timeoutMs ?? METADATA_LIMITS.timeoutMs, 1), METADATA_LIMITS.timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeout);
  const resolve = dependencies.resolve ?? (async (hostname: string) => await lookup(hostname, { all: true, verbatim: true }));
  const request = dependencies.request ?? requestPinnedMetadata;
  try {
    let url = validateMetadataUrl(input);
    for (let hop = 0; hop <= METADATA_LIMITS.redirects; hop++) {
      aborted(controller.signal);
      const target = await resolveMetadataTarget(url, resolve, controller.signal);
      const result = await withinDeadline(request(target, controller.signal), controller.signal);
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.location || hop === METADATA_LIMITS.redirects) throw new MetadataError("unavailable");
        url = validateMetadataUrl(new URL(result.location, url).href);
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw new MetadataError("unavailable");
      return parsePageMetadata(result.body, result.contentType, url.href);
    }
    throw new MetadataError("unavailable");
  } catch (error) {
    if (controller.signal.aborted) throw new MetadataError("timeout");
    if (error instanceof MetadataError) throw error;
    throw new MetadataError("unavailable");
  } finally {
    clearTimeout(timer); dependencies.signal?.removeEventListener("abort", relayAbort);
  }
}
