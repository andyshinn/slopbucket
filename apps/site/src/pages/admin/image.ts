import type { APIRoute } from "astro";
import { proxyImage } from "../../lib/image-proxy.ts";

// /admin/image?url=...: an image from a queued post's text, fetched by the Worker.
// Under /admin, so Cloudflare Access and the admin guard cover it like every admin page.
export const GET: APIRoute = ({ url }) => proxyImage(url.searchParams.get("url"));
