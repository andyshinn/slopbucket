// The public tool page: one published tool, its GitHub stats and its timeline of
// published posts. Merged tools redirect to the tool they were merged into.

import { ROW_COLUMNS, type RawRow, type ToolRow, toRow } from "./public.ts";

export interface ToolDetail extends ToolRow {
  homepage_url: string | null;
  first_seen_at: string;
  license: string | null;
  language: string | null;
}

export interface TimelinePost {
  id: number;
  source: string;
  external_id: string;
  url: string;
  title: string;
  author: string | null;
  posted_at: string;
  post_type: string | null;
  version: string | null;
  /** Latest engagement snapshot (points, or stars for GitHub posts); null before the first. */
  score: number | null;
  comments: number | null;
}

/** The timeline shows at most this many posts, newest first. */
export const TIMELINE_LIMIT = 100;

/** The tool's earliest published post, for "First spotted". */
export interface FirstPost {
  source: string;
  posted_at: string;
}

export type ToolLookup = { tool: ToolDetail; posts: TimelinePost[]; firstPost: FirstPost | null } | { redirect: string } | null;

/** Follows active merges from a hidden tool to the published tool that absorbed it (a few hops at most). */
async function mergeTarget(db: D1Database, toolId: number): Promise<string | null> {
  let id = toolId;
  for (let hop = 0; hop < 5; hop++) {
    const next = await db
      .prepare(
        `SELECT t.id, t.slug, t.status FROM tool_merges m JOIN tools t ON t.id = m.into_tool_id
         WHERE m.from_tool_id = ? AND m.undone_at IS NULL ORDER BY m.merged_at DESC, m.id DESC LIMIT 1`,
      )
      .bind(id)
      .first<{ id: number; slug: string; status: string }>();
    if (!next) return null;
    if (next.status === "published") return next.slug;
    id = next.id;
  }
  return null;
}

/** The tool page's data, a redirect for a merged tool, or null (unknown, queued or hidden). */
export async function lookupTool(db: D1Database, slug: string): Promise<ToolLookup> {
  const row = await db
    .prepare(
      `SELECT ${ROW_COLUMNS}, t.status, t.homepage_url, t.first_seen_at, r.license, r.language
       FROM tools t
       LEFT JOIN repo_snapshots r ON r.tool_id = t.id AND r.date = (SELECT max(date) FROM repo_snapshots WHERE tool_id = t.id)
       WHERE t.slug = ?`,
    )
    .bind(slug)
    .first<RawRow & { status: string; homepage_url: string | null; first_seen_at: string; license: string | null; language: string | null }>();
  if (!row) return null;
  if (row.status !== "published") {
    const target = row.status === "hidden" ? await mergeTarget(db, row.id) : null;
    return target ? { redirect: `/tools/${target}` } : null;
  }
  const { status, homepage_url, first_seen_at, license, language, ...raw } = row;
  const [timeline, first] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT p.id, p.source, p.external_id, p.url, p.title, p.author, p.posted_at, p.post_type, p.version, s.score, s.comments
         FROM posts p
         LEFT JOIN post_snapshots s ON s.post_id = p.id AND s.date = (SELECT max(date) FROM post_snapshots WHERE post_id = p.id)
         WHERE p.tool_id = ? AND p.status = 'published' ORDER BY p.posted_at DESC, p.id DESC LIMIT ?`,
      )
      .bind(row.id, TIMELINE_LIMIT),
    db
      .prepare("SELECT source, posted_at FROM posts WHERE tool_id = ? AND status = 'published' ORDER BY posted_at, id LIMIT 1")
      .bind(row.id),
  ]);
  return {
    tool: { ...toRow(raw), homepage_url, first_seen_at, license, language },
    posts: timeline!.results as unknown as TimelinePost[],
    firstPost: (first!.results[0] as unknown as FirstPost | undefined) ?? null,
  };
}

/** The source's own discussion page for a post, when there is one. */
export function threadUrl(post: Pick<TimelinePost, "source" | "external_id">): { href: string; label: string } | null {
  if (post.source === "hn" && /^\d+$/.test(post.external_id)) return { href: `https://news.ycombinator.com/item?id=${post.external_id}`, label: "Read the HN thread" };
  if (post.source === "lobsters" && /^[a-z0-9]+$/i.test(post.external_id)) return { href: `https://lobste.rs/s/${post.external_id}`, label: "Read the lobste.rs thread" };
  return null;
}

/** "686 points · 362 comments", "1.2k stars"; empty before the first snapshot. */
export function engagement(post: Pick<TimelinePost, "source" | "score" | "comments">, compact: (n: number) => string): string {
  if (post.score === null) return "";
  const plural = (n: number, unit: string) => `${compact(n)} ${unit}${n === 1 ? "" : "s"}`;
  if (post.source === "github") return plural(post.score, "star");
  const parts = [plural(post.score, post.source === "producthunt" ? "vote" : "point")];
  if (post.comments !== null) parts.push(plural(post.comments, "comment"));
  return parts.join(" · ");
}
