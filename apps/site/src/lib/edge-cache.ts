import { SORTS, filterParams, parseFilters } from "./browse.ts";

// Edge caching for public pages with the Workers Cache API. Workers run in
// front of Cloudflare's cache, so a page is only cached if the Worker puts it
// there. Pages change once a day (after the daily run), so a short TTL keeps
// them fresh without purging.

/** Seconds a public page stays in the edge cache. */
export const PAGE_TTL = 300;


/** GET requests for public HTML pages; never /admin or /api, and not /avatar, which caches itself. */
export function isCacheablePath(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  return !/^\/(admin|api|avatar)(\/|$)/.test(pathname);
}

/**
 * The cache key for a page: its path plus the filters as parseFilters reads
 * them, written back in one canonical form. Unknown parameters (utm_*), bad
 * values and reorderings of the same filters share one entry, and the key
 * can't drift from what pages actually read.
 */
export function pageCacheKey(url: URL): Request {
  const params = filterParams(parseFilters(url.searchParams), "trending");
  // Pages differ in their default sort (/new is newest), so the key keeps the
  // sort exactly as asked for, when it is a valid one.
  params.delete("sort");
  const sort = url.searchParams.get("sort");
  if (sort && Object.hasOwn(SORTS, sort)) params.set("sort", sort);
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

/** The visitor's IP as Cloudflare reports it, or null (local dev, tests). */
export const clientIp = (request: Request): string | null => request.headers.get("cf-connecting-ip");

/** True unless the per-IP limiter says this visitor is over its limit. No limiter (tests) means no limit. */
export async function withinLimit(limiter: RateLimit | undefined, request: Request, prefix = "page"): Promise<boolean> {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: `${prefix}:${clientIp(request) ?? "unknown"}` });
  return success;
}

/** A plain 429 page; never cached. */
export function tooManyRequests(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Slow down</title><body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem"><h1>Slow down</h1><p>That\'s a lot of pages in a minute. Wait a moment and try again.</p></body>',
    { status: 429, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60", "cache-control": "no-store" } },
  );
}
