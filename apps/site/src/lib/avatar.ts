// GitHub owner avatars, proxied so visitors' browsers never contact GitHub.

/** GitHub logins: letters, digits and single hyphens, up to 39 characters. */
export const isGithubLogin = (s: string): boolean => /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(s);

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const DAY = 86_400;

/** A stone monogram tile with the first letter of `name`, as SVG. */
export function monogramSvg(name: string): string {
  const letter = (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88"><rect width="88" height="88" fill="#e7e5e4"/><text x="44" y="58" font-family="ui-sans-serif, system-ui, sans-serif" font-size="40" font-weight="600" text-anchor="middle" fill="#44403c">${letter}</text></svg>`;
}

/** The owner's avatar from GitHub, or a monogram when GitHub has none or fails. */
export async function avatarResponse(owner: string, fetcher: typeof fetch = fetch): Promise<Response> {
  if (isGithubLogin(owner)) {
    try {
      const upstream = await fetcher(`https://github.com/${owner}.png?size=88`, { redirect: "follow" });
      const type = upstream.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (upstream.ok && IMAGE_TYPES.includes(type)) {
        return new Response(upstream.body, {
          headers: { "content-type": type, "cache-control": `public, max-age=${DAY}, s-maxage=${7 * DAY}`, "x-content-type-options": "nosniff" },
        });
      }
    } catch {
      // Fall through to the monogram.
    }
  }
  return new Response(monogramSvg(owner), {
    headers: { "content-type": "image/svg+xml", "cache-control": `public, max-age=3600, s-maxage=${DAY}`, "x-content-type-options": "nosniff" },
  });
}
