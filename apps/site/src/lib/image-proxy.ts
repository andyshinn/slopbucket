// Images in the queue's extracted text, fetched by the site Worker (like GitHub's camo),
// so opening a post never tells an image's host who is looking or from where.
import { safeHref } from "./ui.ts";

export const MAX_IMAGE_BYTES = 5_000_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
const DAY = 86_400;

/**
 * Headers for every proxied image. An SVG opened on its own would otherwise run scripts
 * on the admin's origin, so the CSP sandboxes it and blocks every fetch it could make.
 */
const SAFE_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};

const fail = (status: number) => new Response(null, { status, headers: { ...SAFE_HEADERS, "cache-control": "no-store" } });

/** Passes at most `max` bytes through, then errors the stream, so a huge or endless body stops there. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > max) controller.error(new Error("image too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** The image at `raw` (an http(s) URL), or an empty error response when it isn't one. */
export async function proxyImage(raw: string | null, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = raw ? safeHref(raw) : null;
  if (!url) return fail(400);
  let upstream: Response;
  try {
    upstream = await fetcher(url, {
      headers: { accept: IMAGE_TYPES.join(","), "user-agent": "SlopBucket-ImageProxy" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail(502);
  }
  const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (!upstream.ok || !upstream.body || !IMAGE_TYPES.includes(type) || length > MAX_IMAGE_BYTES) {
    await upstream.body?.cancel();
    return fail(upstream.ok ? 415 : 404);
  }
  return new Response(capped(upstream.body, MAX_IMAGE_BYTES), {
    headers: { ...SAFE_HEADERS, "content-type": type, "cache-control": `private, max-age=${DAY}` },
  });
}
