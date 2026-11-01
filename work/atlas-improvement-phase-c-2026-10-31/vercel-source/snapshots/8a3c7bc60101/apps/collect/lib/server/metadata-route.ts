import { fetchPageMetadata, MetadataError, METADATA_LIMITS, type PageMetadata } from "./metadata.ts";

type FetchMetadata = (input: unknown, options: { signal: AbortSignal }) => Promise<PageMetadata>;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error: string, status: number, extra: Record<string, string> = {}) => Response.json({ error }, { status, headers: { ...HEADERS, ...extra } });
class InputError extends Error { readonly status: number; constructor(status: number) { super("入力を確認してください。"); this.status = status; } }

/** NextURL normalizes loopback IPs to localhost; the forwarded browser Host is retained
 * by the fixed local gateway. Compare the Origin to that Host, never to NextURL.hostname.
 */
export function isSameAppRequest(request: Request): boolean {
  const origin = request.headers.get("origin"), host = request.headers.get("host");
  const site = request.headers.get("sec-fetch-site");
  if (!origin || !host || (site && !["same-origin", "none"].includes(site))) return false;
  try {
    const parsed = new URL(origin), protocol = new URL(request.url).protocol;
    const expected = new URL(`${protocol}//${host}`);
    return ["http:", "https:"].includes(protocol) && origin === parsed.origin &&
      !expected.username && !expected.password && expected.pathname === "/" &&
      parsed.protocol === protocol && parsed.host.toLowerCase() === expected.host.toLowerCase();
  } catch { return false; }
}

async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? "")) throw new InputError(415);
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > METADATA_LIMITS.requestBytes)) throw new InputError(413);
  if (!request.body || request.signal.aborted) throw new InputError(400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, wasInterrupted = false, timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = () => { wasInterrupted = true; void reader.cancel().catch(() => {}); reject(new InputError(408)); };
    timer = setTimeout(rejectInterrupted, 4000);
    request.signal.addEventListener("abort", rejectInterrupted, { once: true });
  });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), interrupted]);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > METADATA_LIMITS.requestBytes) { void reader.cancel().catch(() => {}); throw new InputError(413); }
      chunks.push(result.value);
    }
    if (wasInterrupted) throw new InputError(408);
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw new InputError(400); }
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", rejectInterrupted);
    reader.releaseLock();
  }
}

/** Anonymous device mode remains usable. A fixed per-process budget bounds the local
 * service; public deployments may add their own authenticated edge rate limiter.
 */
export function createMetadataPostHandler(fetchMetadata: FetchMetadata = fetchPageMetadata, now: () => number = Date.now) {
  let windowStart = now(), requests = 0, active = 0;
  return async function POST(request: Request): Promise<Response> {
    if (request.method !== "POST") return failure("POSTで送信してください。", 405, { Allow: "POST" });
    if (!isSameAppRequest(request)) return failure("Collectの画面から操作してください。", 403);
    const current = now();
    if (current - windowStart >= 60000) { windowStart = current; requests = 0; }
    if (active >= 4 || requests >= 24) return failure("ページ情報の取得が混み合っています。少し待ってから再試行してください。", 429, { "Retry-After": "60" });
    requests++; active++;
    try {
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input) || !("url" in input)) throw new InputError(400);
      const metadata = await fetchMetadata((input as { url: unknown }).url, { signal: request.signal });
      return Response.json(metadata, { headers: HEADERS });
    } catch (error) {
      if (error instanceof InputError) return failure(error.status === 413 ? "入力が長すぎます。URLだけを送信してください。" : "URLの入力形式を確認してください。", error.status);
      if (error instanceof MetadataError) return failure(error.message, error.code === "unsafe" ? 400 : error.code === "timeout" ? 504 : error.code === "too_large" ? 413 : error.code === "unsupported" ? 422 : 502);
      return failure("ページ情報を取得できませんでした。収集した内容は保存されています。", 502);
    } finally { active--; }
  };
}
