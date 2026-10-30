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
