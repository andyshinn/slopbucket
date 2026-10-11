import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { guardAdmin, isAdminPath } from "./lib/access.ts";
import { cacheableCopy, edgeCache, isCacheablePath, pageCacheKey, tooManyRequests, withinLimit } from "./lib/edge-cache.ts";

export const onRequest = defineMiddleware(async (context, next) => {
  if (!isAdminPath(context.url.pathname)) {
    const cache = isCacheablePath(context.request.method, context.url.pathname) ? edgeCache() : null;
    if (!cache) return next();
    const key = pageCacheKey(context.url);
    const hit = await cache.match(key);
    if (hit) return hit;
    // Only cache misses cost D1 reads, so only they count toward the per-IP limit.
    if (!(await withinLimit(env.PAGE_LIMITER, context.request))) return tooManyRequests();
    const response = await next();
    const copy = cacheableCopy(response);
    if (!copy) return response;
    context.locals.cfContext?.waitUntil(cache.put(key, copy.clone()));
    return copy;
  }

  const result = await guardAdmin(context.request, env as unknown as Record<string, unknown>);
  if ("response" in result) return result.response;

  context.locals.adminEmail = result.email;
  const response = await next();
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
});
