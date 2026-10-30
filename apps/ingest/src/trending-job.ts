import { type TrendingJob, getSetting } from "@slop-bucket/core";
import type { Deps } from "./deps.ts";
import { USER_AGENT, getJson } from "./http.ts";

const DAY = 86_400_000;
/** Posts from this window count toward S, P and C. */
const ENGAGEMENT_DAYS = 14;
/** A tool with a post in this window (or new stars) is active. */
const ACTIVE_DAYS = 30;
const HN_BATCH = 50;
const GITHUB_BATCH = 50;
/** Without GH_API_TOKEN, GitHub allows 60 requests an hour; leave room for README fetches. */
const UNAUTHENTICATED_REPO_LIMIT = 40;

const iso = (ms: number) => new Date(ms).toISOString();

export interface Weights {
  w_s: number;
  w_e: number;
  w_g: number;
  g: number;
}

export interface TrendingInput {
  /** Distinct sources with a post in the last 14 days. */
  sources: number;
  /** Upvotes and comments across those posts (GitHub stars are left out; they count as star growth). */
  points: number;
  comments: number;
  starsGained7d: number;
  /** Hours since the tool's most recent post. */
  hours: number;
}

/**
 * The formula in docs/DESIGN.md "Trending score and activity". Flags can push a
 * lobste.rs score below zero, so net-negative engagement counts as none.
 */
export function trendingScore(t: TrendingInput, w: Weights): number {
  const engagement = w.w_s * t.sources + w.w_e * Math.log1p(Math.max(0, t.points + 2 * t.comments)) + w.w_g * Math.log1p(Math.max(0, t.starsGained7d));
  return engagement / Math.pow(Math.max(0, t.hours) + 2, w.g);
}

/**
 * Daily after ingestion: refresh engagement on recent posts, snapshot GitHub stats for
 * active tools, then recompute every tool's trending score and active flag. Problems
 * that leave the job partly done (a rate limit, one failed request) are recorded on the
 * run instead of failing it, so the scores still update.
 */
export async function runTrendingJob(job: TrendingJob, deps: Deps, now = Date.now()): Promise<void> {
  const { db } = deps;
  const run = await db.prepare("INSERT INTO source_runs (source, mode) VALUES ('trending', ?) RETURNING id").bind(job.mode).first<{ id: number }>();
  const finish = (tools: number, error: string | null) =>
    db
      .prepare("UPDATE source_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), items_fetched = ?, error = ? WHERE id = ?")
      .bind(tools, error, run!.id)
      .run();
  const warnings: string[] = [];
  try {
    const today = iso(now).slice(0, 10);
    const posts = await refreshEngagement(deps, now, today, warnings);
    const repos = await snapshotRepos(deps, today, warnings);
    const tools = await scoreTools(db, now, warnings);
    await finish(tools, warnings.length ? warnings.join("; ") : null);
    console.log(JSON.stringify({ event: "trending", mode: job.mode, posts, repos, tools, warnings }));
  } catch (err) {
    await finish(0, String(err));
    throw err;
  }
}

/** New post_snapshots rows for HN and lobste.rs posts of visible tools from the last 14 days. */
async function refreshEngagement(deps: Deps, now: number, today: string, warnings: string[]): Promise<number> {
  const { results } = await deps.db
    .prepare(
      `SELECT p.id, p.source, p.external_id FROM posts p JOIN tools t ON t.id = p.tool_id
       WHERE p.status IN ('published', 'queued') AND t.status != 'hidden'
         AND p.source IN ('hn', 'lobsters') AND p.posted_at >= ?`,
    )
    .bind(iso(now - ENGAGEMENT_DAYS * DAY))
    .all<{ id: number; source: string; external_id: string }>();

  const counts = new Map<number, { score: number; comments: number }>();
  const hn = results.filter((p) => p.source === "hn");
  for (let i = 0; i < hn.length; i += HN_BATCH) {
    const batch = hn.slice(i, i + HN_BATCH);
    const tags = `story,(${batch.map((p) => `story_${p.external_id}`).join(",")})`;
    const params = new URLSearchParams({ tags, hitsPerPage: String(HN_BATCH), attributesToRetrieve: "points,num_comments" });
    try {
      const body = (await getJson(deps.fetch, `https://hn.algolia.com/api/v1/search?${params}`)) as {
        hits: { objectID: string; points?: number | null; num_comments?: number | null }[];
      };
      const byId = new Map(batch.map((p) => [p.external_id, p.id]));
      for (const h of body.hits) {
        const id = byId.get(h.objectID);
        if (id !== undefined) counts.set(id, { score: h.points ?? 0, comments: h.num_comments ?? 0 });
      }
    } catch (err) {
      warnings.push(`HN engagement: ${String(err)}`);
    }
  }
  let lobstersFailed = 0;
  for (const p of results.filter((r) => r.source === "lobsters")) {
    try {
      const story = (await getJson(deps.fetch, `https://lobste.rs/s/${encodeURIComponent(p.external_id)}.json`)) as { score: number; comment_count: number };
      counts.set(p.id, { score: story.score, comments: story.comment_count });
    } catch {
      lobstersFailed++;
    }
    await deps.sleep(500); // be gentle with lobste.rs
  }
  if (lobstersFailed) warnings.push(`lobste.rs engagement: ${lobstersFailed} posts failed`);

  const statements = [...counts].map(([postId, c]) =>
    deps.db
      .prepare(
        `INSERT INTO post_snapshots (post_id, date, score, comments) VALUES (?, ?, ?, ?)
         ON CONFLICT (post_id, date) DO UPDATE SET score = excluded.score, comments = excluded.comments`,
      )
      .bind(postId, today, c.score, c.comments),
  );
  for (let i = 0; i < statements.length; i += 100) await deps.db.batch(statements.slice(i, i + 100));
  return counts.size;
}

interface RepoStats {
  stars: number;
  forks: number;
  language: string | null;
  license: string | null;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Today's repo_snapshots row for each active, visible tool with a GitHub repo. */
async function snapshotRepos(deps: Deps, today: string, warnings: string[]): Promise<number> {
  const { results } = await deps.db
    .prepare("SELECT id, github_repo FROM tools WHERE github_repo IS NOT NULL AND status != 'hidden' AND is_active = 1 ORDER BY trending_score DESC, id")
    .all<{ id: number; github_repo: string }>();
  const tools = results.filter((t) => REPO.test(t.github_repo));
  const stats = new Map<number, RepoStats>();

  if (deps.githubToken) {
    for (let i = 0; i < tools.length; i += GITHUB_BATCH) {
      try {
        for (const [id, s] of await githubGraphql(deps, tools.slice(i, i + GITHUB_BATCH))) stats.set(id, s);
      } catch (err) {
        warnings.push(`GitHub stats: ${String(err)}`);
        break;
      }
    }
  } else {
    for (const t of tools.slice(0, UNAUTHENTICATED_REPO_LIMIT)) {
      const res = await deps.fetch(`https://api.github.com/repos/${t.github_repo}`, {
        headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403 || res.status === 429) break;
      if (!res.ok) continue;
      const r = (await res.json()) as { stargazers_count: number; forks_count: number; language: string | null; license: { spdx_id: string } | null };
      stats.set(t.id, { stars: r.stargazers_count, forks: r.forks_count, language: r.language, license: r.license?.spdx_id ?? null });
    }
    if (stats.size < tools.length) warnings.push(`GitHub stats for ${stats.size} of ${tools.length} repos; add the GH_API_TOKEN secret for the rest`);
  }

  const statements = [...stats].map(([toolId, s]) =>
    deps.db
      .prepare(
        `INSERT INTO repo_snapshots (tool_id, date, stars, forks, language, license) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tool_id, date) DO UPDATE SET stars = excluded.stars, forks = excluded.forks, language = excluded.language, license = excluded.license`,
      )
      .bind(toolId, today, s.stars, s.forks, s.language, s.license),
  );
  for (let i = 0; i < statements.length; i += 100) await deps.db.batch(statements.slice(i, i + 100));
  return stats.size;
}

/** One GraphQL request for up to 50 repos. Missing or renamed repos come back null and are skipped. */
async function githubGraphql(deps: Deps, tools: { id: number; github_repo: string }[]): Promise<Map<number, RepoStats>> {
  const fields = "stargazerCount forkCount primaryLanguage { name } licenseInfo { spdxId }";
  const query = `{ ${tools
    .map((t, i) => {
      const [owner, name] = t.github_repo.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
    })
    .join(" ")} }`;
  const res = await deps.fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "user-agent": USER_AGENT, authorization: `Bearer ${deps.githubToken}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`POST /graphql -> ${res.status}`);
  type Repo = { stargazerCount: number; forkCount: number; primaryLanguage: { name: string } | null; licenseInfo: { spdxId: string } | null } | null;
  const body = (await res.json()) as { data?: Record<string, Repo> | null };
  const out = new Map<number, RepoStats>();
  tools.forEach((t, i) => {
    const r = body.data?.[`r${i}`];
    if (r) out.set(t.id, { stars: r.stargazerCount, forks: r.forkCount, language: r.primaryLanguage?.name ?? null, license: r.licenseInfo?.spdxId ?? null });
  });
  return out;
}

/** Recomputes trending_score and is_active for every tool that is not hidden. Returns how many were scored. */
async function scoreTools(db: D1Database, now: number, warnings: string[]): Promise<number> {
  const weights = await getSetting(db, "trending_weights");
  const { results } = await db
    .prepare(
      `WITH recent AS (
         SELECT p.tool_id, p.source,
           (SELECT score FROM post_snapshots s WHERE s.post_id = p.id ORDER BY date DESC LIMIT 1) AS score,
           (SELECT comments FROM post_snapshots s WHERE s.post_id = p.id ORDER BY date DESC LIMIT 1) AS comments
         FROM posts p
         WHERE p.tool_id IS NOT NULL AND p.status IN ('published', 'queued') AND p.posted_at >= ?1
       ),
       engagement AS (
         SELECT tool_id, count(DISTINCT source) AS sources,
           sum(CASE WHEN source != 'github' THEN coalesce(score, 0) ELSE 0 END) AS points,
           sum(CASE WHEN source != 'github' THEN coalesce(comments, 0) ELSE 0 END) AS comments
         FROM recent GROUP BY tool_id
       )
       SELECT t.id, t.is_open_source, coalesce(t.last_post_at, t.first_seen_at) AS last_at,
         coalesce(e.sources, 0) AS sources, coalesce(e.points, 0) AS points, coalesce(e.comments, 0) AS comments,
         (SELECT stars FROM repo_snapshots s WHERE s.tool_id = t.id ORDER BY date DESC LIMIT 1) AS stars_now,
         (SELECT stars FROM repo_snapshots s WHERE s.tool_id = t.id AND date <= ?2 ORDER BY date DESC LIMIT 1) AS stars_week_ago
       FROM tools t LEFT JOIN engagement e ON e.tool_id = t.id
       WHERE t.status != 'hidden'`,
    )
    .bind(iso(now - ENGAGEMENT_DAYS * DAY), iso(now - 7 * DAY).slice(0, 10))
    .all<{
      id: number;
      is_open_source: number | null;
      last_at: string;
      sources: number;
      points: number;
      comments: number;
      stars_now: number | null;
      stars_week_ago: number | null;
    }>();

  const activeSince = iso(now - ACTIVE_DAYS * DAY);
  const unscorable: number[] = [];
  const statements = results.map((t) => {
    // Star growth needs a snapshot from a week ago; closed-source tools have no star term.
    const starsGained7d = t.is_open_source !== 0 && t.stars_now !== null && t.stars_week_ago !== null ? Math.max(0, t.stars_now - t.stars_week_ago) : 0;
    const hours = (now - Date.parse(t.last_at)) / 3_600_000;
    let score = trendingScore({ sources: t.sources, points: t.points, comments: t.comments, starsGained7d, hours }, weights);
    // D1 binds NaN as NULL, which the NOT NULL column rejects and fails the whole batch.
    if (!Number.isFinite(score)) {
      unscorable.push(t.id);
      score = 0;
    }
    const active = t.last_at >= activeSince || starsGained7d > 0 ? 1 : 0;
    return db.prepare("UPDATE tools SET trending_score = ?, is_active = ? WHERE id = ?").bind(score, active, t.id);
  });
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
  if (unscorable.length) warnings.push(`trending score not a number for tools ${unscorable.join(", ")}; set to 0`);
  return results.length;
}
