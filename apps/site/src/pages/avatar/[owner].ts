import type { APIRoute } from "astro";
import { avatarResponse } from "../../lib/avatar.ts";
import { edgeCache } from "../../lib/edge-cache.ts";

// /avatar/{owner}: the GitHub owner's avatar, or an SVG monogram, cached at the edge.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const cache = edgeCache();
  const hit = await cache?.match(request);
  if (hit) return hit;
  const response = await avatarResponse((params.owner ?? "").toLowerCase());
  if (cache) locals.cfContext?.waitUntil(cache.put(request, response.clone()));
  return response;
};
