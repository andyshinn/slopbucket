// Per-IP rate limits with Workers rate-limiting bindings (see wrangler.jsonc).

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
