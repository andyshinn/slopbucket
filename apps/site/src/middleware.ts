import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { type CategoryInfo, getSetting } from "@slop-bucket/core";
import { guardAdmin, isAdminPath } from "./lib/access.ts";
import { cacheableCopy, edgeCache, isCacheablePath, pageCacheKey } from "./lib/edge-cache.ts";
import { tooManyRequests, withinLimit } from "./lib/rate-limit.ts";

export const onRequest = defineMiddleware(async (context, next) => {
  // Category labels and colors, for any badge or tile on the page; only read if one renders.
  let categoryInfo: Promise<CategoryInfo> | undefined;
  context.locals.categoryInfo = () => (categoryInfo ??= getSetting(env.DB, "category_info"));

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
