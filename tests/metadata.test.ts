import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import type { IncomingMessage } from "node:http";
import {
  fetchPageMetadata, isPublicAddress, MetadataError, METADATA_LIMITS, parsePageMetadata,
  pinnedRequestOptions, requestPinnedMetadata, validateMetadataUrl,
  type MetadataHop, type ValidatedTarget,
} from "../apps/collect/lib/server/metadata.ts";
import { createMetadataPostHandler, isSameAppRequest } from "../apps/collect/lib/server/metadata-route.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];
const html = (text = "<title>Saved page</title>"): MetadataHop => ({ status: 200, contentType: "text/html; charset=utf-8", body: encode(text) });
const rejected = async (action: Promise<unknown>, code: string) => assert.rejects(action, error => error instanceof MetadataError && error.code === code);

test("metadata refuses alternate IP spellings, credentials, local names and non-HTTPS destinations", () => {
  for (const value of ["http://example.com", "https://example.com:444", "https://user:secret@example.com", "https://localhost/", "https://api.localhost/", "https://metadata.google.internal/", "https://printer.lan/", "https://127.0.0.1/", "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "file:///secret", "https://example.com/\nsecret", "https://exa_mple.com/"]) {
    assert.throws(() => validateMetadataUrl(value), MetadataError, value);
  }
  assert.equal(validateMetadataUrl(" https://EXAMPLE.com.:443/page?q=one#fragment ").href, "https://example.com/page?q=one");
});

test("metadata DNS classification denies all private, special and tunneled addresses", () => {
  for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.2", "192.168.0.1", "192.0.0.9", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "64:ff9b:1::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "2001:20::1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});

test("mixed DNS answers and private redirect targets never reach the network adapter", async () => {
  let networkCalls = 0;
  await rejected(fetchPageMetadata("https://example.com/", { resolve: async () => [...await publicDns(), { address: "10.1.2.3", family: 4 }], request: async () => { networkCalls++; return html(); } }), "unsafe");
  assert.equal(networkCalls, 0);
  const resolved: string[] = [];
  await rejected(fetchPageMetadata("https://example.com/", {
    resolve: async hostname => { resolved.push(hostname); return hostname === "example.com" ? publicDns() : [{ address: "169.254.169.254", family: 4 }]; },
    request: async () => { networkCalls++; return { status: 302, location: "https://redirect.example.com/metadata", body: new Uint8Array() }; },
  }), "unsafe");
  assert.deepEqual(resolved, ["example.com", "redirect.example.com"]); assert.equal(networkCalls, 1);
  await rejected(fetchPageMetadata("https://example.com/", { resolve: publicDns, request: async () => ({ status: 302, location: "http://example.com/plaintext", body: new Uint8Array() }) }), "unsafe");
});

test("every public redirect is re-resolved, bounded, and uses its vetted address", async () => {
  const targets: ValidatedTarget[] = [], names: string[] = [];
  const metadata = await fetchPageMetadata("https://example.com/one#private-fragment", {
    resolve: async name => { names.push(name); return publicDns(); },
    request: async target => { targets.push(target); return targets.length === 1 ? { status: 302, location: "/two?x=1", body: new Uint8Array() } : html("<title>Second &amp; final</title>"); },
  });
  assert.deepEqual(names, ["example.com", "example.com"]); assert.equal(targets[1].address, "93.184.215.14");
  assert.equal(metadata.title, "Second & final"); assert.equal(metadata.finalUrl, "https://example.com/two?x=1");
  let calls = 0;
  await rejected(fetchPageMetadata("https://example.com/", { resolve: publicDns, request: async () => { calls++; return { status: 302, location: "/again", body: new Uint8Array() }; } }), "unavailable");
  assert.equal(calls, METADATA_LIMITS.redirects + 1);
});

test("pinned HTTPS options prevent a second DNS lookup while retaining TLS name validation", async () => {
  const target: ValidatedTarget = { url: new URL("https://example.com/path?x=1"), address: "93.184.215.14", family: 4 };
  const options = pinnedRequestOptions(target, new AbortController().signal);
  assert.equal(options.hostname, "example.com"); assert.equal(options.servername, "example.com"); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false); assert.equal(options.port, 443); assert.equal(options.path, "/path?x=1");
  assert.deepEqual(Object.keys(options.headers ?? {}).sort(), ["Accept", "Accept-Encoding", "User-Agent"]);
  const answer = await new Promise(resolve => { (options.lookup as Function)("changed-to-private.example.com", {}, (error: unknown, address: string, family: number) => resolve({ error, address, family })); });
  assert.deepEqual(answer, { error: null, address: "93.184.215.14", family: 4 });
});

function fakeHttps(response: { status?: number; headers?: Record<string, string>; chunks?: Uint8Array[]; fail?: boolean; neverEnd?: boolean }) {
  return ((_options: unknown, callback: (message: IncomingMessage) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (response.fail) { req.emit("error", new Error("secret network URL must not escape")); return; }
      const incoming = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      incoming.statusCode = response.status ?? 200; incoming.headers = response.headers ?? { "content-type": "text/html" };
      callback(incoming as unknown as IncomingMessage);
      if (!incoming.destroyed) { for (const chunk of response.chunks ?? [encode("<title>Network stream</title>")]) { if (!incoming.destroyed) incoming.write(chunk); } if (!response.neverEnd) incoming.end(); }
    });
    return req;
  }) as unknown as typeof https.request;
}

test("production transport limits streamed and declared sizes and refuses compressed/non-HTML responses", async () => {
  const target: ValidatedTarget = { url: new URL("https://example.com/"), address: "93.184.215.14", family: 4 }, signal = new AbortController().signal;
  const result = await requestPinnedMetadata(target, signal, fakeHttps({})); assert.equal(new TextDecoder().decode(result.body), "<title>Network stream</title>");
  await rejected(requestPinnedMetadata(target, signal, fakeHttps({ chunks: [new Uint8Array(METADATA_LIMITS.bytes), encode("x")] })), "too_large");
  await rejected(requestPinnedMetadata(target, signal, fakeHttps({ headers: { "content-type": "text/html", "content-length": String(METADATA_LIMITS.bytes + 1) } })), "too_large");
  await rejected(requestPinnedMetadata(target, signal, fakeHttps({ headers: { "content-type": "text/html", "content-encoding": "gzip" } })), "unsupported");
  await rejected(requestPinnedMetadata(target, signal, fakeHttps({ headers: { "content-type": "application/json" } })), "unsupported");
  await rejected(requestPinnedMetadata(target, signal, fakeHttps({ fail: true })), "unavailable");
});

test("metadata timeout also bounds DNS and adapter hangs", async () => {
  await rejected(fetchPageMetadata("https://example.com/", { timeoutMs: 10, resolve: async () => await new Promise(() => {}) }), "timeout");
  await rejected(fetchPageMetadata("https://example.com/", { timeoutMs: 10, resolve: publicDns, request: async () => await new Promise(() => {}) }), "timeout");
});

test("HTML metadata is inert decoded text with model-aligned UTF-16 limits", () => {
  const metadata = parsePageMetadata(encode('<script>throw "never run"</script><title>Fallback</title><META PROPERTY="og:title" CONTENT="A &amp; B &lt;script&gt;"><meta name="description" content=" line&#10; two "><meta property="og:image" content="http://127.0.0.1/private"><meta property="og:site_name" content="Site">'));
  assert.equal(metadata.title, "A & B <script>"); assert.equal(metadata.description, "line two"); assert.equal(metadata.siteName, "Site");
  const unicode = parsePageMetadata(encode(`<title>${"😀".repeat(200)}</title><meta name="description" content="${"😀".repeat(1100)}">`));
  assert.equal(unicode.title.length, 300); assert.equal(unicode.description.length, 2000); assert.equal(unicode.title.endsWith("😀"), true);
  assert.equal("image" in metadata, false);
});

const request = (url: unknown = "https://example.com/", headers: Record<string, string> = {}) => new Request("http://localhost:3403/collect/api/metadata/", { method: "POST", headers: { host: "127.0.0.1:3400", origin: "http://127.0.0.1:3400", "content-type": "application/json", ...headers }, body: JSON.stringify({ url }) });
test("route uses browser Host despite Next loopback normalization, and rejects foreign browser origins", async () => {
  assert.equal(isSameAppRequest(request()), true);
  for (const headers of [{ origin: "http://evil.example" }, { origin: "http://localhost:3400" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { origin: "http://127.0.0.1:3400/path" }]) assert.equal(isSameAppRequest(request(undefined, headers)), false);
  let calls = 0; const handler = createMetadataPostHandler(async () => { calls++; return { title: "title", description: "", siteName: "", finalUrl: "https://example.com/" }; });
  const accepted = await handler(request()); assert.equal(accepted.status, 200); assert.equal(accepted.headers.get("cache-control"), "private, no-store");
  assert.equal((await handler(request(undefined, { origin: "https://evil.example" }))).status, 403); assert.equal(calls, 1);
});

test("route bounds malformed/oversized bodies and aggregate concurrency/rate without trusting client IP headers", async () => {
  let release: (() => void)[] = [], calls = 0, time = 0;
  const handler = createMetadataPostHandler(async () => { calls++; await new Promise<void>(resolve => release.push(resolve)); return { title: "title", description: "", siteName: "", finalUrl: "https://example.com/" }; }, () => time);
  const pending = Array.from({ length: 4 }, () => handler(request()));
  while (calls < 4) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await handler(request())).status, 429); for (const resolve of release) resolve(); await Promise.all(pending);
  const immediate = createMetadataPostHandler(async () => ({ title: "title", description: "", siteName: "", finalUrl: "https://example.com/" }), () => time);
  assert.equal((await immediate(request("x", { "content-length": "20000" }))).status, 413);
  assert.equal((await immediate(request("x", { "content-type": "text/plain" }))).status, 415);
  assert.equal((await immediate(request("x".repeat(17000)))).status, 413);
  for (let i = 0; i < 21; i++) assert.equal((await immediate(request())).status, 200);
  assert.equal((await immediate(request(undefined, { "x-forwarded-for": "8.8.8.8" }))).status, 429);
  time = 60001; assert.equal((await immediate(request())).status, 200);
});
