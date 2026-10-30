import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTrendingJob, trendingScore } from "../src/trending-job.ts";
import { fakeFetch, json, makeDeps, resetDb } from "./helpers.ts";

beforeEach(resetDb);

const NOW = Date.parse("2026-10-08T07:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const db = env.DB;

describe("trendingScore", () => {
  const w = { w_s: 3, w_e: 1, w_g: 1.5, g: 1.5 };
  it("follows the design formula", () => {
    const s = trendingScore({ sources: 2, points: 100, comments: 20, starsGained7d: 50, hours: 10 }, w);
    expect(s).toBeCloseTo((3 * 2 + Math.log(1 + 140) + 1.5 * Math.log(51)) / Math.pow(12, 1.5), 10);
  });
  it("decays with age and ignores star losses", () => {
    const base = { sources: 1, points: 10, comments: 0, starsGained7d: 0, hours: 1 };
    expect(trendingScore({ ...base, hours: 100 }, w)).toBeLessThan(trendingScore(base, w));
    expect(trendingScore({ ...base, starsGained7d: -20 }, w)).toBe(trendingScore(base, w));
  });
  it("treats net-negative engagement as none", () => {
    const base = { sources: 1, points: 0, comments: 0, starsGained7d: 0, hours: 1 };
    for (const points of [-1, -4]) expect(trendingScore({ ...base, points }, w)).toBe(trendingScore(base, w));
  });
});

async function tool(id: number, over: { repo?: string | null; open?: number; status?: string; lastPost: string }) {
  await db
    .prepare("INSERT INTO tools (id, slug, name, github_repo, is_open_source, status, first_seen_at, last_post_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, `t${id}`, `T${id}`, over.repo ?? null, over.open ?? 1, over.status ?? "queued", over.lastPost, over.lastPost)
    .run();
}
let postId = 0;
async function post(toolId: number, source: string, externalId: string, postedAt: string, snapshot?: [number, number]) {
  const id = ++postId;
  await db
    .prepare("INSERT INTO posts (id, source, external_id, url, canonical_url, title, posted_at, status, tool_id) VALUES (?, ?, ?, 'u', 'u', 't', ?, 'queued', ?)")
    .bind(id, source, externalId, postedAt, toolId)
    .run();
  if (snapshot) await db.prepare("INSERT INTO post_snapshots (post_id, date, score, comments) VALUES (?, '2026-10-07', ?, ?)").bind(id, ...snapshot).run();
  return id;
}

const hnAlgolia = (hits: unknown[]) => (url: string) => (url.startsWith("https://hn.algolia.com/api/v1/search?") ? json({ hits }) : undefined);

describe("runTrendingJob", () => {
  it("refreshes engagement and GitHub stats, then scores and flags tools", async () => {
    await tool(1, { repo: "acme/hot", lastPost: hoursAgo(5) });
    await tool(2, { repo: null, open: 0, lastPost: hoursAgo(5) });
    await tool(3, { repo: "acme/old", lastPost: hoursAgo(24 * 40) });
    await tool(4, { repo: "acme/hidden", status: "hidden", lastPost: hoursAgo(1) });
    const hnPost = await post(1, "hn", "111", hoursAgo(5), [10, 2]);
    const lobPost = await post(1, "lobsters", "abc123", hoursAgo(6));
    await post(1, "github", "acme/hot", hoursAgo(7), [5000, 0]); // stars are not upvotes
    await post(2, "hn", "222", hoursAgo(5), [3, 0]);
    await post(3, "hn", "333", hoursAgo(24 * 40), [500, 100]); // too old to refresh or count
    await db.prepare("UPDATE tools SET is_active = 1").run();
    await db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars) VALUES (1, '2026-10-01', 100), (3, '2026-10-01', 70)").run();

    const fetch = fakeFetch(
      hnAlgolia([
        { objectID: "111", points: 120, num_comments: 40 },
        { objectID: "222", points: 4, num_comments: 1 },
      ]),
      (url) => (url === "https://lobste.rs/s/abc123.json" ? json({ score: 15, comment_count: 5 }) : undefined),
      (url) =>
        url === "https://api.github.com/graphql"
          ? json({
              data: {
                r0: { stargazerCount: 160, forkCount: 9, primaryLanguage: { name: "Rust" }, licenseInfo: { spdxId: "MIT" } },
                r1: null, // renamed or deleted
              },
            })
          : undefined,
    );
    await runTrendingJob({ kind: "trending", mode: "daily" }, makeDeps({ fetch, githubToken: "t" }), NOW);

    // HN is batched; only recent posts of visible tools are refreshed.
    expect(fetch.calls.filter((u) => u.includes("algolia"))).toHaveLength(1);
    expect(decodeURIComponent(fetch.calls[0]!)).toContain("tags=story,(story_111,story_222)");
    const snaps = await db.prepare("SELECT post_id, score, comments FROM post_snapshots WHERE date = '2026-10-08' ORDER BY post_id").all();
    expect(snaps.results).toEqual([
      { post_id: hnPost, score: 120, comments: 40 },
      { post_id: lobPost, score: 15, comments: 5 },
      { post_id: hnPost + 3, score: 4, comments: 1 },
    ]);
    const repos = await db.prepare("SELECT tool_id, stars, forks, language, license FROM repo_snapshots WHERE date = '2026-10-08'").all();
    expect(repos.results).toEqual([{ tool_id: 1, stars: 160, forks: 9, language: "Rust", license: "MIT" }]);

    const tools = Object.fromEntries(
      (await db.prepare("SELECT id, trending_score, is_active FROM tools").all<{ id: number; trending_score: number; is_active: number }>()).results.map((t) => [t.id, t]),
    );
    const w = { w_s: 3, w_e: 1, w_g: 1.5, g: 1.5 };
    // Tool 1: HN + lobste.rs + GitHub sources; 135 points, 45 comments (no GitHub stars); 60 stars gained.
    expect(tools[1]!.trending_score).toBeCloseTo(trendingScore({ sources: 3, points: 135, comments: 45, starsGained7d: 60, hours: 5 }, w), 6);
    expect(tools[2]!.trending_score).toBeCloseTo(trendingScore({ sources: 1, points: 4, comments: 1, starsGained7d: 0, hours: 5 }, w), 6);
    expect(tools[1]!.trending_score).toBeGreaterThan(tools[2]!.trending_score);
    expect(tools[3]).toMatchObject({ is_active: 0 }); // no post in 30 days and no new stars
    expect(tools[1]).toMatchObject({ is_active: 1 });
    expect(tools[4]!.trending_score).toBe(0); // hidden tools are left alone

    const run = await db.prepare("SELECT source, mode, items_fetched, error, finished_at FROM source_runs").first();
    expect(run).toMatchObject({ source: "trending", mode: "daily", items_fetched: 3, error: null });
    expect(run!.finished_at).not.toBeNull();
  });

  it("without a GitHub token, snapshots what it can and says so", async () => {
    await tool(1, { repo: "acme/a", lastPost: hoursAgo(1) });
    await tool(2, { repo: "acme/b", lastPost: hoursAgo(1) });
    const fetch = fakeFetch(
      (url) => (url === "https://api.github.com/repos/acme/a" ? json({ stargazers_count: 5, forks_count: 1, language: "Go", license: null }) : undefined),
      (url) => (url === "https://api.github.com/repos/acme/b" ? new Response("rate limited", { status: 403 }) : undefined),
    );
    await runTrendingJob({ kind: "trending", mode: "manual" }, makeDeps({ fetch }), NOW);
    expect((await db.prepare("SELECT count(*) AS n FROM repo_snapshots").first())!.n).toBe(1);
    const run = await db.prepare("SELECT mode, error FROM source_runs").first<{ mode: string; error: string }>();
    expect(run!.mode).toBe("manual");
    expect(run!.error).toContain("GitHub stats for 1 of 2 repos; add the GH_API_TOKEN secret");
  });

  it("scores a tool whose only engagement is a flagged lobste.rs story", async () => {
    await tool(1, { repo: null, open: 0, lastPost: hoursAgo(2) });
    await post(1, "lobsters", "flagd1", hoursAgo(2));
    await db.prepare("UPDATE tools SET is_active = 1").run();
    // Flags push a lobste.rs score below zero; ln(1 + P + 2C) must not go NaN.
    const fetch = fakeFetch((url) => (url === "https://lobste.rs/s/flagd1.json" ? json({ score: -4, comment_count: 0 }) : undefined));
    await runTrendingJob({ kind: "trending", mode: "daily" }, makeDeps({ fetch }), NOW);
    const t = await db.prepare("SELECT trending_score FROM tools WHERE id = 1").first<{ trending_score: number }>();
    const w = { w_s: 3, w_e: 1, w_g: 1.5, g: 1.5 };
    expect(t!.trending_score).toBeCloseTo(trendingScore({ sources: 1, points: 0, comments: 0, starsGained7d: 0, hours: 2 }, w), 6);
    const run = await db.prepare("SELECT items_fetched, error FROM source_runs").first();
    expect(run).toMatchObject({ items_fetched: 1, error: null });
  });

  it("scores 0 and warns instead of failing the batch when a score is not a number", async () => {
    await tool(1, { repo: null, lastPost: hoursAgo(1) });
    await tool(2, { repo: null, lastPost: hoursAgo(1) });
    await post(1, "github", "acme/a", hoursAgo(1));
    await db.prepare("UPDATE tools SET trending_score = 5, last_post_at = 'not a date', first_seen_at = 'not a date' WHERE id = 2").run();
    await runTrendingJob({ kind: "trending", mode: "daily" }, makeDeps({ fetch: fakeFetch() }), NOW);
    const scores = (await db.prepare("SELECT id, trending_score FROM tools ORDER BY id").all<{ id: number; trending_score: number }>()).results;
    expect(scores[0]!.trending_score).toBeGreaterThan(0);
    expect(scores[1]!.trending_score).toBe(0);
    const run = await db.prepare("SELECT items_fetched, error FROM source_runs").first();
    expect(run).toMatchObject({ items_fetched: 2, error: "trending score not a number for tools 2; set to 0" });
  });

  it("records a failed run and rethrows", async () => {
    await tool(1, { repo: null, lastPost: hoursAgo(1) });
    await post(1, "hn", "111", hoursAgo(1));
    const deps = makeDeps({ fetch: fakeFetch(() => json({ hits: [] })) });
    const original = await db.prepare("SELECT value FROM settings WHERE key = 'trending_weights'").first<{ value: string }>();
    await db.prepare("UPDATE settings SET value = '{}' WHERE key = 'trending_weights'").run();
    try {
      await expect(runTrendingJob({ kind: "trending", mode: "daily" }, deps, NOW)).rejects.toThrow();
      const run = await db.prepare("SELECT error FROM source_runs").first<{ error: string }>();
      expect(run!.error).toBeTruthy();
    } finally {
      await db.prepare("UPDATE settings SET value = ? WHERE key = 'trending_weights'").bind(original!.value).run();
    }
  });
});
