// Edge caching for public pages with the Workers Cache API. Workers run in
// front of Cloudflare's cache, so a page is only cached if the Worker puts it
// there. Pages change once a day (after the daily run), so a short TTL keeps
// them fresh without purging.

/** Seconds a public page stays in the edge cache. */
export const PAGE_TTL = 300;

/**
 * Query parameters that change what a public page shows. Everything else
 * (utm_*, typos) is dropped from the cache key, so it can't create extra cache
 * entries or D1 reads. A page that reads a new parameter must add it here.
 */
export const PAGE_PARAMS = ["page"];

/** GET requests for public HTML pages; never /admin or /api, and not /avatar, which caches itself. */
export function isCacheablePath(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  return !/^\/(admin|api|avatar)(\/|$)/.test(pathname);
}

/** The cache key for a page: its path plus the PAGE_PARAMS it was given, sorted. */
export function pageCacheKey(url: URL): Request {
  const params = new URLSearchParams();
  for (const name of PAGE_PARAMS) for (const value of url.searchParams.getAll(name)) params.append(name, value);
  params.sort();
  const query = params.toString();
  return new Request(`${url.origin}${url.pathname}${query ? `?${query}` : ""}`);
}

/** The edge cache, or null where the runtime has none (astro dev, tests). */
export function edgeCache(): Cache | null {
  return typeof caches !== "undefined" && "default" in caches ? (caches as unknown as { default: Cache }).default : null;
}

/** A copy of a successful HTML response marked cacheable for PAGE_TTL. */
export function cacheableCopy(response: Response): Response | null {
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return null;
  // A cookie or the page's own cache-control means the response may be per-visitor;
  // public pages set neither (no sessions, no auth), so this is a safety net.
  if (response.headers.has("set-cookie") || response.headers.has("cache-control")) return null;
  const copy = new Response(response.body, response);
  copy.headers.set("cache-control", `public, max-age=60, s-maxage=${PAGE_TTL}`);
  return copy;
}
