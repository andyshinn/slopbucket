import type { Fetcher } from "./deps.ts";

export const USER_AGENT = "slop-bucket/0.1 (+https://slopbucket.app)";

export async function getJson(fetcher: Fetcher, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetcher(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/** A stored `owner/repo`, checked before it goes into a GitHub API path. */
export const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Headers for api.github.com, with the token when there is one. */
export function githubHeaders(token: string | undefined, accept = "application/vnd.github+json"): Record<string, string> {
  return { "user-agent": USER_AGENT, accept, ...(token && { authorization: `Bearer ${token}` }) };
}

export interface RepoStats {
  stars: number;
  forks: number;
  language: string | null;
  license: string | null;
}

/**
 * One repo's stats from the REST API. `missing` when the repo is gone or private
 * (404/410), `limited` when GitHub is rate limiting (403/429); throws on anything else.
 */
export async function fetchRepoStats(fetcher: Fetcher, token: string | undefined, repo: string): Promise<RepoStats | "missing" | "limited"> {
  if (!GITHUB_REPO.test(repo)) return "missing";
  const res = await fetcher(`https://api.github.com/repos/${repo}`, { headers: githubHeaders(token), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404 || res.status === 410) return "missing";
  if (res.status === 403 || res.status === 429) return "limited";
  if (!res.ok) throw new Error(`GET /repos/${repo} -> ${res.status}`);
  const r = (await res.json()) as { stargazers_count?: unknown; forks_count?: unknown; language?: string | null; license?: { spdx_id?: string } | null };
  if (typeof r.stargazers_count !== "number") throw new Error(`GET /repos/${repo}: no stargazers_count`);
  return {
    stars: r.stargazers_count,
    forks: typeof r.forks_count === "number" ? r.forks_count : 0,
    language: r.language ?? null,
    license: r.license?.spdx_id ?? null,
  };
}

/** Upserts one tool's repo_snapshots row for `date`. */
export const upsertRepoSnapshot = (db: D1Database, toolId: number, date: string, s: RepoStats) =>
  db
    .prepare(
      `INSERT INTO repo_snapshots (tool_id, date, stars, forks, language, license) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool_id, date) DO UPDATE SET stars = excluded.stars, forks = excluded.forks, language = excluded.language, license = excluded.license`,
    )
    .bind(toolId, date, s.stars, s.forks, s.language, s.license);
