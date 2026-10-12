import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizedPostSchema, type NormalizedPost } from "@slop-bucket/core";
import type { Fetcher } from "../src/deps.ts";
import { DAILY_CREATED_LOOKBACK, github, parseTrending, repoTitle } from "../src/sources/github.ts";
import type { SourceContext } from "../src/sources/types.ts";
import searchFixture from "./fixtures/github-search.json";
import trendingHtml from "./fixtures/github-trending.html?raw";
import { fakeFetch, json } from "./helpers.ts";

const UNTIL = Date.parse("2026-10-06T06:00:00Z");
const ctx = (fetcher: Fetcher, over: Partial<SourceContext> = {}): SourceContext & { slept: number[] } => {
  const slept: number[] = [];
  return { fetch: fetcher, db: env.DB, sleep: async (ms) => void slept.push(ms), slept, ...over };
};
async function collect(iter: AsyncIterable<NormalizedPost[]>) {
  const pages: NormalizedPost[][] = [];
  for await (const page of iter) pages.push(page);
  return pages;
}
const searchRoute = (body: unknown) => (u: string) => (u.startsWith("https://api.github.com/search/repositories?") ? json(body) : undefined);
const trendingRoute = (u: string) => (u === "https://github.com/trending?since=daily" ? new Response(trendingHtml) : undefined);
const queries = (calls: string[]) => calls.filter((u) => u.includes("/search/")).map((u) => new URL(u).searchParams.get("q"));

describe("parseTrending", () => {
  it("reads repo, description and total stars from each row", () => {
    const rows = parseTrending(trendingHtml);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ fullName: "mattpocock/skills", stars: 278172 });
    expect(rows.every((r) => r.fullName.split("/").length === 2)).toBe(true);
  });
});

describe("github adapter", () => {
  it("daily: searches each topic for repos created in the last week with enough stars, then reads Trending", async () => {
    const fetcher = fakeFetch(searchRoute(searchFixture), trendingRoute);
    const c = ctx(fetcher);
    const pages = await collect(github.fetchPosts({ since: UNTIL - 26 * 3_600_000, until: UNTIL, mode: "daily" }, c));

    const qs = queries(fetcher.calls);
    expect(qs).toHaveLength(13); // one per seeded topic
    expect(qs[0]).toBe(
      `topic:mcp created:${new Date(UNTIL - DAILY_CREATED_LOOKBACK).toISOString().replace(".000Z", "Z")}..2026-10-06T06:00:00Z stars:>=10 archived:false`,
    );
    expect(c.slept.every((ms) => ms === 13_000)).toBe(true); // unauthenticated pacing

    const posts = pages.flat();
    for (const p of posts) normalizedPostSchema.parse(p);
    const repo = posts.find((p) => p.external_id === "feder-cr/dots")!;
    expect(repo).toMatchObject({ source: "github", url: "https://github.com/feder-cr/dots", score: 2635, comments: 0 });
    expect(repo.title.startsWith("feder-cr/dots")).toBe(true);

    const trending = pages.at(-1)!;
    expect(trending).toHaveLength(3);
    expect(trending[1]).toMatchObject({ external_id: "mattpocock/skills", tags: ["trending"], posted_at: "2026-10-06T06:00:00.000Z" });
  });

  it("backfill: searches the window only and skips Trending", async () => {
    const fetcher = fakeFetch(searchRoute(searchFixture));
    const since = Date.parse("2026-09-01T00:00:00Z");
    await collect(github.fetchPosts({ since, until: since + 86_400_000, mode: "backfill" }, ctx(fetcher, { githubToken: "t" })));
    expect(queries(fetcher.calls)[0]).toContain("created:2026-09-01T00:00:00Z..2026-09-02T00:00:00Z");
    expect(fetcher.calls.some((u) => u.includes("/trending"))).toBe(false);
  });

  it("sends the token and paces faster when one is set", async () => {
    let auth: string | null = null;
    const fetcher = fakeFetch((u) => {
      if (!u.includes("/search/")) return undefined;
      return json({ items: [] });
    }, trendingRoute);
    const spy: Fetcher = async (u, init) => {
      auth ??= new Headers(init?.headers).get("authorization");
      return fetcher(u, init);
    };
    const c = ctx(spy, { githubToken: "ghp_test" });
    await collect(github.fetchPosts({ since: 0, until: UNTIL, mode: "daily" }, c));
    expect(auth).toBe("Bearer ghp_test");
    expect(c.slept.every((ms) => ms === 4_200)).toBe(true);
  });

  it("waits out a short rate limit once, then fails on a second limit", async () => {
    let calls = 0;
    const limited = () => new Response("rate limited", { status: 403, headers: { "retry-after": "30" } });
    const fetcher = fakeFetch((u) => (u.includes("/search/") ? (++calls === 1 ? limited() : json({ items: [] })) : undefined), trendingRoute);
    const c = ctx(fetcher);
    await collect(github.fetchPosts({ since: 0, until: UNTIL, mode: "daily" }, c));
    expect(c.slept[0]).toBe(30_000);

    const always = fakeFetch(() => limited());
    await expect(collect(github.fetchPosts({ since: 0, until: UNTIL, mode: "daily" }, ctx(always)))).rejects.toThrow("403");
  });

  it("fails loudly when Trending markup no longer parses", async () => {
    const fetcher = fakeFetch(searchRoute({ items: [] }), (u) => (u.includes("/trending") ? new Response("<html><body>new layout</body></html>") : undefined));
    await expect(collect(github.fetchPosts({ since: 0, until: UNTIL, mode: "daily" }, ctx(fetcher)))).rejects.toThrow("markup may have changed");
  });

  it("titles repos as owner/name: description", () => {
    expect(repoTitle("a/b", "  Does things  ")).toBe("a/b: Does things");
    expect(repoTitle("a/b", null)).toBe("a/b");
    expect(repoTitle("a/b", "x".repeat(300))).toHaveLength("a/b: ".length + 200);
  });
});
