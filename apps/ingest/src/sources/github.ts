import { parseHTML } from "linkedom";
import { z } from "zod";
import { type NormalizedPost, getSetting } from "@slop-bucket/core";
import { USER_AGENT, githubHeaders } from "../http.ts";
import type { Adapter, SourceContext } from "./types.ts";

const DAY = 86_400_000;
// Daily runs look at repos created in the last week: new repos gain stars over
// their first days, so each one is picked up when it crosses github_min_stars.
export const DAILY_CREATED_LOOKBACK = 7 * DAY;
const PAGE_SIZE = 100;
const MAX_PAGES = 10; // GitHub search returns at most 1,000 results per query.
// Search allows 30 requests/minute with a token and 10 without, shared by every job
// using that token. FETCH_CONCURRENCY jobs can run at once (a backfill fans out into
// one job per day), so each job paces itself to its share, plus a small margin.
export const FETCH_CONCURRENCY = 2; // the sb-fetch consumer's max_concurrency in wrangler.jsonc; a test checks it
export const SEARCH_PER_MINUTE = { token: 30, anon: 10 };
export const searchPauseMs = (perMinute: number) => Math.ceil((60_000 * FETCH_CONCURRENCY) / perMinute) + 200;

const repoSchema = z.object({
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  stargazers_count: z.number(),
  topics: z.array(z.string()).default([]),
  fork: z.boolean().default(false),
  archived: z.boolean().default(false),
  owner: z.object({ login: z.string() }),
});
const searchSchema = z.object({ items: z.array(repoSchema) });

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function repoTitle(fullName: string, description: string | null): string {
  const desc = description?.trim();
  return desc ? `${fullName}: ${desc.length > 200 ? `${desc.slice(0, 199)}…` : desc}` : fullName;
}

function toPost(repo: z.infer<typeof repoSchema>): NormalizedPost {
  return {
    source: "github",
    // The same key as Trending, so a repo found both ways is stored once.
    external_id: repo.full_name.toLowerCase(),
    url: repo.html_url,
    title: repoTitle(repo.full_name, repo.description),
    author: repo.owner.login,
    posted_at: new Date(repo.created_at).toISOString(),
    score: repo.stargazers_count,
    comments: 0,
    tags: repo.topics,
  };
}

async function searchPage(ctx: SourceContext, q: string, page: number): Promise<z.infer<typeof searchSchema>> {
  const params = new URLSearchParams({ q, sort: "stars", order: "desc", per_page: String(PAGE_SIZE), page: String(page) });
  const headers = githubHeaders(ctx.githubToken);
  for (let attempt = 1; ; attempt++) {
    const res = await ctx.fetch(`https://api.github.com/search/repositories?${params}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return searchSchema.parse(await res.json());
    // Rate limited: wait once if GitHub says how long and it is short; otherwise fail the run (the queue retries later).
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    const waitS = retryAfter ? Number(retryAfter) : reset ? Number(reset) - Date.now() / 1000 : 0;
    if ((res.status === 403 || res.status === 429) && attempt === 1 && waitS > 0 && waitS <= 70) {
      await ctx.sleep(waitS * 1000);
      continue;
    }
    throw new Error(`GitHub search "${q}" page ${page} -> ${res.status}`);
  }
}

/** Repos on github.com/trending today. No API exists, so this parses the page. */
export function parseTrending(html: string): { fullName: string; description: string | null; stars: number }[] {
  const { document } = parseHTML(html);
  return [...document.querySelectorAll("article.Box-row")].flatMap((row) => {
    const href = row.querySelector("h2 a")?.getAttribute("href")?.trim();
    const fullName = href?.replace(/^\//, "");
    if (!fullName || fullName.split("/").length !== 2) return [];
    const description = row.querySelector("p")?.textContent?.trim() || null;
    const starsText = row.querySelector(`a[href="/${fullName}/stargazers"]`)?.textContent ?? "0";
    return [{ fullName, description, stars: Number(starsText.replace(/[^\d]/g, "")) || 0 }];
  });
}

export const github: Adapter = {
  source: "github",
  windowed: true,
  async *fetchPosts({ since, until, mode }, ctx) {
    const [topics, minStars] = await Promise.all([getSetting(ctx.db, "github_topics"), getSetting(ctx.db, "github_min_stars")]);
    // Backfills take repos created in the window; daily and manual runs take the last week.
    const createdFrom = mode === "backfill" ? since : until - DAILY_CREATED_LOOKBACK;
    const created = `created:${isoSeconds(createdFrom)}..${isoSeconds(until)}`;
    const pause = searchPauseMs(ctx.githubToken ? SEARCH_PER_MINUTE.token : SEARCH_PER_MINUTE.anon);

    let first = true;
    for (const topic of topics) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (!first) await ctx.sleep(pause);
        first = false;
        const { items } = await searchPage(ctx, `topic:${topic} ${created} stars:>=${minStars} archived:false`, page);
        yield items.filter((r) => !r.fork && !r.archived).map(toPost);
        if (items.length < PAGE_SIZE) break;
      }
    }

    if (mode === "backfill") return; // Trending has no history.
    const res = await ctx.fetch("https://github.com/trending?since=daily", {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub Trending -> ${res.status}`);
    const trending = parseTrending(await res.text());
    if (trending.length === 0) throw new Error("GitHub Trending: no repositories parsed; the page markup may have changed");
    yield trending.map((r) => ({
      source: "github",
      external_id: r.fullName.toLowerCase(),
      url: `https://github.com/${r.fullName}`,
      title: repoTitle(r.fullName, r.description),
      author: r.fullName.split("/")[0]!,
      // When it was seen trending; Trending repos are often years old.
      posted_at: new Date(until).toISOString(),
      score: r.stars,
      comments: 0,
      tags: ["trending"],
    }));
  },
};
