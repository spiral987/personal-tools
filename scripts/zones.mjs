/** Next rewrites external-only basePath:false: https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites */
export function sketchbookOrigin(value = "http://127.0.0.1:3101") {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new Error("SKETCHBOOK_ORIGIN must be an HTTPS origin (or a local loopback HTTP origin).");
  }
  return url.origin;
}
export function sketchbookRewrites(value) {
  const origin = sketchbookOrigin(value);
  // A repeated :path* token discards the terminal slash. Capture the raw suffix so
  // page / and file .js keep their distinct spelling with trailingSlash:true.
  return [{source:"/sketchbook/:path(.*)",destination:`${origin}/sketchbook/:path`,basePath:false}];
}

/** Collect is an independent zone; only a server-configured origin is accepted. */
export function collectOrigin(value = "http://127.0.0.1:3103") {
  try { return sketchbookOrigin(value); }
  catch { throw new Error("COLLECT_ORIGIN must be an HTTPS origin (or a local loopback HTTP origin)."); }
}
export function collectRewrites(value) {
  return [{source:"/collect/:path(.*)",destination:`${collectOrigin(value)}/collect/:path`,basePath:false}];
}
export function atlasOrigin(value = "http://127.0.0.1:3104") {
  try { return sketchbookOrigin(value); }
  catch { throw new Error("ATLAS_ORIGIN must be an HTTPS origin (or a local loopback HTTP origin)."); }
}
export function atlasRewrites(value) {
  return [{source:"/atlas/:path(.*)",destination:`${atlasOrigin(value)}/atlas/:path`,basePath:false}];
}
