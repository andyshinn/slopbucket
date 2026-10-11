// Read-only queries and formatting for the public pages. Public pages show
// published tools and published posts only, and never confidence.

import { isGithubLogin } from "./avatar.ts";

export const PAGE_SIZE = 25;

export interface ToolRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[];
  github_repo: string | null;
  /** Null when the classifier couldn't tell. */
  is_open_source: boolean | null;
  /** Published posts linked to the tool. */
  posts: number;
  /** Distinct sources of those posts, e.g. ["github", "hn"]. */
  sources: string[];
  last_posted_at: string | null;
  /** Latest repo snapshot, or null before the first one. */
  stars: number | null;
  /** Stars gained since the newest snapshot at least 7 days old; null until one exists. */
  stars_gained_7d: number | null;
}

export interface RawRow extends Omit<ToolRow, "tags" | "sources" | "is_open_source" | "stars_gained_7d"> {
  tags: string;
  sources: string | null;
  is_open_source: number | null;
  stars_week_ago: number | null;
}

const PUBLISHED_POSTS = "FROM posts p WHERE p.tool_id = t.id AND p.status = 'published'";
/** Columns of a ToolRow, for a query FROM tools t. */
export const ROW_COLUMNS = `t.id, t.slug, t.name, t.description, coalesce(t.category, 'other') AS category, t.tags, t.github_repo, t.is_open_source,
  (SELECT count(*) ${PUBLISHED_POSTS}) AS posts,
  (SELECT group_concat(DISTINCT p.source) ${PUBLISHED_POSTS}) AS sources,
  (SELECT max(p.posted_at) ${PUBLISHED_POSTS}) AS last_posted_at,
  (SELECT r.stars FROM repo_snapshots r WHERE r.tool_id = t.id ORDER BY r.date DESC LIMIT 1) AS stars,
  (SELECT r.stars FROM repo_snapshots r WHERE r.tool_id = t.id AND r.date <= date('now', '-7 days') ORDER BY r.date DESC LIMIT 1) AS stars_week_ago`;

export function toRow(raw: RawRow): ToolRow {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // A malformed tags column shows no tags rather than breaking the page.
  }
  const { stars_week_ago, ...rest } = raw;
  return {
    ...rest,
    tags,
    sources: raw.sources ? raw.sources.split(",").sort() : [],
    is_open_source: raw.is_open_source === null ? null : raw.is_open_source === 1,
    stars_gained_7d: raw.stars !== null && stars_week_ago !== null ? raw.stars - stars_week_ago : null,
  };
}

export interface HomeStats {
  /** Published tools. */
  tools: number;
  /** Every stored post, whatever happened to it. */
  postsRead: number;
  /** Posts the classifier dropped. */
  tossed: number;
  /** When the latest scheduled run finished, or null. */
  lastRun: string | null;
}

export async function homeStats(db: D1Database): Promise<HomeStats> {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*) FROM tools WHERE status = 'published') AS tools,
        (SELECT count(*) FROM posts) AS postsRead,
        (SELECT count(*) FROM posts WHERE status = 'dropped') AS tossed,
        (SELECT max(finished_at) FROM source_runs WHERE mode = 'daily' AND finished_at IS NOT NULL) AS lastRun`,
    )
    .first<HomeStats>();
  return row ?? { tools: 0, postsRead: 0, tossed: 0, lastRun: null };
}

/** Pages beyond this are treated as page 1 (keeps OFFSET a small integer). */
const MAX_PAGE = 10_000;

/** The page number from a `page` query parameter: an integer from 1 to MAX_PAGE, else 1. */
export function pageParam(value: string | null): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
}

/** 6.6k, 12k, 1.2M; small numbers as they are. */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** "today", "yesterday", "5 days ago", or "Sep 2" (UTC days). */
export function dayAgo(iso: string, now = Date.now()): string {
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  const days = day(now) - day(Date.parse(iso));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Oct 7, 06:03 UTC" */
export function runTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

/** The repo owner, for the avatar route; null unless `repo` is "owner/name". */
export function repoOwner(repo: string | null): string | null {
  const [owner, name, ...rest] = repo?.split("/") ?? [];
  if (!owner || !name || rest.length > 0 || !/^[\w.-]+$/.test(name) || !isGithubLogin(owner)) return null;
  return owner.toLowerCase();
}
