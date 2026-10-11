import type { APIRoute } from "astro";
import { avatarResponse } from "../../lib/avatar.ts";
import { edgeCache } from "../../lib/edge-cache.ts";

// /avatar/{owner}: the GitHub owner's avatar, or an SVG monogram, cached at the edge.
// The cache key is the path alone, so query strings can't bypass the cache.
export const GET: APIRoute = async ({ params, url, locals }) => {
  const owner = (params.owner ?? "").toLowerCase();
  const key = new Request(`${url.origin}/avatar/${encodeURIComponent(owner)}`);
  const cache = edgeCache();
  const hit = await cache?.match(key);
  if (hit) return hit;
  const response = await avatarResponse(owner);
  if (cache && response.headers.get("cache-control") !== "no-store") locals.cfContext?.waitUntil(cache.put(key, response.clone()));
  return response;
};
