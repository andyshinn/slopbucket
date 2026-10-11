import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { avatarResponse, isGithubLogin, monogramSvg } from "../src/lib/avatar.ts";
import { cacheableCopy, isCacheablePath, pageCacheKey } from "../src/lib/edge-cache.ts";
import { PAGE_SIZE, compactNumber, dayAgo, homeStats, pageParam, repoOwner } from "../src/lib/public.ts";
import { browse, parseFilters } from "../src/lib/browse.ts";

const trendingTools = (_db: D1Database, page: number) => browse(_db, { ...parseFilters(new URLSearchParams()), page }, []);

const db = env.DB;
beforeEach(async () => {
  await db.batch(["post_snapshots", "repo_snapshots", "tool_aliases", "posts", "source_runs", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

let n = 0;
async function tool(name: string, over: { status?: string; score?: number; repo?: string; openSource?: number | null; tags?: string[] } = {}) {
  const row = await db
    .prepare(
      "INSERT INTO tools (slug, name, category, tags, github_repo, is_open_source, status, trending_score) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(`${name.toLowerCase()}-${++n}`, name, JSON.stringify(over.tags ?? []), over.repo ?? null, over.openSource === undefined ? 1 : over.openSource, over.status ?? "published", over.score ?? 0)
    .first<{ id: number }>();
  return row!.id;
}
async function post(toolId: number | null, source: string, status = "published", postedAt = "2026-10-05T00:00:00.000Z") {
  await db
    .prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, tool_id) VALUES (?, ?, 'https://x.dev', 'https://x.dev', 'A post', ?, ?, ?)")
    .bind(source, `e${++n}`, postedAt, status, toolId)
    .run();
}

describe("trendingTools", () => {
  it("lists published tools by score with published posts, sources and star gain", async () => {
    const a = await tool("Alpha", { score: 1, repo: "acme/alpha", tags: ["claude-code"] });
    const b = await tool("Beta", { score: 5, openSource: null });
    await tool("Hidden", { status: "hidden", score: 9 });
    await tool("Queued", { status: "queued", score: 9 });
    await post(a, "hn", "published", "2026-10-03T00:00:00.000Z");
    await post(a, "github", "published", "2026-10-06T00:00:00.000Z");
    await post(a, "lobsters", "queued", "2026-10-09T00:00:00.000Z");
    await db.batch([
      db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars) VALUES (?, date('now'), 1500)").bind(a),
      db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars) VALUES (?, date('now', '-8 days'), 1000)").bind(a),
      db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars) VALUES (?, date('now', '-20 days'), 10)").bind(a),
    ]);

    const { tools, total } = await trendingTools(db, 1);
    expect(total).toBe(2);
    expect(tools.map((t) => t.name)).toEqual(["Beta", "Alpha"]);
    expect(tools[1]).toMatchObject({
      posts: 2,
      sources: ["github", "hn"],
      last_posted_at: "2026-10-06T00:00:00.000Z",
      stars: 1500,
      stars_gained_7d: 500,
      tags: ["claude-code"],
      is_open_source: true,
    });
    expect(tools[0]).toMatchObject({ posts: 0, sources: [], stars: null, stars_gained_7d: null, is_open_source: null });
  });

  it("hides the star gain until a week-old snapshot exists, and pages by PAGE_SIZE", async () => {
    const a = await tool("Fresh", { repo: "acme/fresh" });
    await db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars) VALUES (?, date('now', '-2 days'), 40)").bind(a).run();
    expect((await trendingTools(db, 1)).tools[0]).toMatchObject({ stars: 40, stars_gained_7d: null });

    for (let i = 0; i < PAGE_SIZE; i++) await tool(`T${i}`, { score: 100 - i });
    expect((await trendingTools(db, 1)).tools).toHaveLength(PAGE_SIZE);
    expect((await trendingTools(db, 2)).tools.map((t) => t.name)).toEqual(["Fresh"]);
  });
});

describe("homeStats", () => {
  it("counts published tools, all posts, dropped posts and the last daily run", async () => {
    const a = await tool("Alpha");
    await tool("Queued", { status: "queued" });
    await post(a, "hn");
    await post(null, "hn", "dropped");
    await db.batch([
      db.prepare("INSERT INTO source_runs (source, started_at, finished_at, mode) VALUES ('hn', '2026-10-10T06:00:00Z', '2026-10-10T06:03:00Z', 'daily')"),
      db.prepare("INSERT INTO source_runs (source, started_at, finished_at, mode) VALUES ('hn', '2026-10-11T09:00:00Z', '2026-10-11T09:01:00Z', 'manual')"),
      db.prepare("INSERT INTO source_runs (source, started_at, mode) VALUES ('github', '2026-10-11T06:00:00Z', 'daily')"),
    ]);
    expect(await homeStats(db)).toEqual({ tools: 1, postsRead: 2, tossed: 1, lastRun: "2026-10-10T06:03:00Z" });
  });
});

describe("formatting", () => {
  it("parses page numbers", () => {
    expect([pageParam(null), pageParam("3"), pageParam("0"), pageParam("-2"), pageParam("1.5"), pageParam("x"), pageParam("1e308"), pageParam("10001")]).toEqual([1, 3, 1, 1, 1, 1, 1, 1]);
  });

  it("shortens counts and dates", () => {
    expect([compactNumber(950), compactNumber(6600), compactNumber(1_250_000)]).toEqual(["950", "6.6K", "1.3M"]);
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(dayAgo("2026-10-11T01:00:00Z", now)).toBe("today");
    expect(dayAgo("2026-10-10T23:00:00Z", now)).toBe("yesterday");
    expect(dayAgo("2026-10-06T12:00:00Z", now)).toBe("5 days ago");
    expect(dayAgo("2026-08-02T12:00:00Z", now)).toBe("Aug 2");
  });

  it("takes the owner from owner/repo only", () => {
    expect(repoOwner("Anthropics/claude-code")).toBe("anthropics");
    expect(repoOwner("https://github.com/a/b")).toBeNull();
    expect(repoOwner("../x/y")).toBeNull();
    expect(repoOwner("foo-/bar")).toBeNull();
    expect(repoOwner("a--b/bar")).toBeNull();
    expect(repoOwner(null)).toBeNull();
  });
});

describe("avatars", () => {
  it("accepts GitHub logins only", () => {
    expect(isGithubLogin("max-sixty")).toBe(true);
    expect(isGithubLogin("-bad")).toBe(false);
    expect(isGithubLogin("a--b")).toBe(false);
    expect(isGithubLogin("x".repeat(40))).toBe(false);
  });

  it("proxies the GitHub image and falls back to a monogram", async () => {
    const png = (async () => new Response("PNG", { headers: { "content-type": "image/png" } })) as typeof fetch;
    const ok = await avatarResponse("acme", png);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(await ok.text()).toBe("PNG");

    const html = (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    const missing = (async () => new Response("", { status: 404 })) as typeof fetch;
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    for (const [fetcher, cached] of [[html, true], [missing, true], [down, false], [failing, false]] as const) {
      const res = await avatarResponse("acme", fetcher);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("cache-control") !== "no-store").toBe(cached);
      expect(await res.text()).toContain(">A</text>");
    }
    let called = false;
    await avatarResponse("not/a/login", (async () => ((called = true), new Response())) as typeof fetch);
    expect(called).toBe(false);
    expect(monogramSvg("<script>")).toContain(">S</text>");
  });
});

describe("edge cache", () => {
  it("caches public GET pages only", () => {
    expect(isCacheablePath("GET", "/")).toBe(true);
    expect(isCacheablePath("GET", "/about")).toBe(true);
    expect(isCacheablePath("POST", "/")).toBe(false);
    expect(isCacheablePath("GET", "/admin/queue")).toBe(false);
    expect(isCacheablePath("GET", "/api/health")).toBe(false);
    expect(isCacheablePath("GET", "/administer")).toBe(true);
    expect(isCacheablePath("GET", "/avatar/acme")).toBe(false);
  });

  it("keys pages by path and the parameters they read", () => {
    const key = (u: string) => pageCacheKey(new URL(u)).url;
    expect(key("https://slopbucket.app/?utm_source=x&page=2")).toBe("https://slopbucket.app/?page=2");
    expect(key("https://slopbucket.app/?a=1")).toBe("https://slopbucket.app/");
    expect(key("https://slopbucket.app/search?tag=b&q=x&tag=a&utm=1")).toBe("https://slopbucket.app/search?q=x&tag=b&tag=a");
    // Equivalent filters share a key; bad values drop out.
    expect(key("https://slopbucket.app/search?q=%20x%20&tag=b&tag=b&stars=7&license=maybe&page=1")).toBe("https://slopbucket.app/search?q=x&tag=b");
    // The sort stays as asked for, since pages differ in their default.
    expect(key("https://slopbucket.app/new?sort=trending")).toBe("https://slopbucket.app/new?sort=trending");
    expect(key("https://slopbucket.app/new?sort=bogus")).toBe("https://slopbucket.app/new");
    expect(key("https://slopbucket.app/about?b=2#ranking")).toBe("https://slopbucket.app/about");
  });

  it("marks successful HTML responses cacheable and leaves others alone", () => {
    const html = (status = 200, headers: Record<string, string> = {}) => new Response("x", { status, headers: { "content-type": "text/html", ...headers } });
    expect(cacheableCopy(html())?.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=300");
    expect(cacheableCopy(html(404))).toBeNull();
    expect(cacheableCopy(html(200, { "set-cookie": "a=b" }))).toBeNull();
    expect(cacheableCopy(html(200, { "cache-control": "no-store" }))).toBeNull();
    expect(cacheableCopy(new Response("{}", { headers: { "content-type": "application/json" } }))).toBeNull();
  });
});

describe("rate limits", () => {
  it("allows without a limiter, and keys the limiter by IP", async () => {
    const { withinLimit, tooManyRequests } = await import("../src/lib/rate-limit.ts");
    const req = new Request("https://slopbucket.app/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(await withinLimit(undefined, req)).toBe(true);
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length < 2 }) } as RateLimit;
    expect(await withinLimit(limiter, req)).toBe(true);
    expect(await withinLimit(limiter, req)).toBe(false);
    expect(keys).toEqual(["page:203.0.113.9", "page:203.0.113.9"]);
    const res = tooManyRequests();
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
