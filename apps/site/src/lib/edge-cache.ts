// Edge caching for public pages with the Workers Cache API. Workers run in
// front of Cloudflare's cache, so a page is only cached if the Worker puts it
// there. Pages change once a day (after the daily run), so a short TTL keeps
// them fresh without purging.

/** Seconds a public page stays in the edge cache. */
export const PAGE_TTL = 300;

/** GET requests for public HTML pages; never /admin or /api. */
export function isCacheablePath(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  return !/^\/(admin|api)(\/|$)/.test(pathname);
}

/** The edge cache, or null where the runtime has none (astro dev, tests). */
export function edgeCache(): Cache | null {
  return typeof caches !== "undefined" && "default" in caches ? (caches as unknown as { default: Cache }).default : null;
}

/** A copy of a successful HTML response marked cacheable for PAGE_TTL. */
export function cacheableCopy(response: Response): Response | null {
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return null;
  if (response.headers.has("set-cookie") || response.headers.has("cache-control")) return null;
  const copy = new Response(response.body, response);
  copy.headers.set("cache-control", `public, max-age=60, s-maxage=${PAGE_TTL}`);
  return copy;
}
