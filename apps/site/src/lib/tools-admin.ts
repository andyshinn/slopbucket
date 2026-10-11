import {
  getSetting,
  hostOf,
  isGenericHost,
  normalizeGithubRepo,
  normalizeHomepage,
  normalizeToolName,
  tagSlugs,
} from "@slop-bucket/core";

export class ToolError extends Error {}

export const TOOL_STATUSES = ["published", "queued", "hidden"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];
export const TOOL_SORTS = { trending: "Trending", newest: "Newest", recent: "Latest post", name: "Name" } as const;
export type ToolSort = keyof typeof TOOL_SORTS;
const ORDER: Record<ToolSort, string> = {
  trending: "t.trending_score DESC, t.id DESC",
  newest: "t.first_seen_at DESC, t.id DESC",
  recent: "t.last_post_at DESC NULLS LAST, t.id DESC",
  name: "lower(t.name), t.id",
};
export const PAGE_SIZE = 50;

export interface ToolRow {
  id: number;
  slug: string;
  name: string;
  github_repo: string | null;
  category: string | null;
  status: ToolStatus;
  is_open_source: number | null;
  last_post_at: string | null;
  posts: number;
  /** Name of the tool this one was merged into (it is then hidden). */
  merged_into: string | null;
}

export interface ToolFilters {
  q?: string;
  status?: string;
  category?: string;
  sort?: string;
  page?: number;
}

/**
 * The admin tools list. The search matches the name or any alias (repos, domains,
 * normalized names) by substring; instr() rather than LIKE, which production D1
 * rejects for patterns over 50 bytes.
 */
export async function listTools(db: D1Database, f: ToolFilters): Promise<{ tools: ToolRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const q = f.q?.trim().toLowerCase();
  if (q) {
    // Name aliases are stored normalized ("Work Trunk CLI" -> "worktrunk"), so also try that form.
    const normalized = normalizeToolName(q) || q;
    where.push(
      "(instr(lower(t.name), ?) > 0 OR EXISTS (SELECT 1 FROM tool_aliases a WHERE a.tool_id = t.id AND (instr(a.value, ?) > 0 OR instr(a.value, ?) > 0)))",
    );
    params.push(q, q, normalized);
  }
  if (f.status && (TOOL_STATUSES as readonly string[]).includes(f.status)) {
    where.push("t.status = ?");
    params.push(f.status);
  }
  if (f.category) {
    where.push("t.category = ?");
    params.push(f.category);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = ORDER[(f.sort as ToolSort) in ORDER ? (f.sort as ToolSort) : "trending"];
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const [rows, count] = await db.batch([
    db
      .prepare(
        `SELECT t.id, t.slug, t.name, t.github_repo, t.category, t.status, t.is_open_source, t.last_post_at,
           (SELECT count(*) FROM posts p WHERE p.tool_id = t.id) AS posts,
           (SELECT i.name FROM tool_merges m JOIN tools i ON i.id = m.into_tool_id
            WHERE m.from_tool_id = t.id AND m.undone_at IS NULL ORDER BY m.id DESC LIMIT 1) AS merged_into
         FROM tools t ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    db.prepare(`SELECT count(*) AS n FROM tools t ${clause}`).bind(...params),
  ]);
  return { tools: rows!.results as ToolRow[], total: (count!.results[0] as { n: number }).n };
}

export async function toolStatusCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare("SELECT status, count(*) AS n FROM tools GROUP BY status").all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, r.n]));
}

export interface ToolDetail {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  homepage_url: string | null;
  github_repo: string | null;
  is_open_source: number | null;
  status: ToolStatus;
  first_seen_at: string;
  last_post_at: string | null;
  /** via_merge: moved here by a merge that hasn't been split back out. */
  aliases: { kind: "repo" | "domain" | "name"; value: string; via_merge: boolean }[];
  posts: { id: number; title: string; source: string; url: string; posted_at: string; post_type: string | null; status: string }[];
  postCount: number;
}

/** Posts on the edit page by default; "Show all" raises it to POSTS_ALL. */
export const POSTS_DEFAULT = 20;
export const POSTS_ALL = 500;

export async function getTool(db: D1Database, id: number, postLimit = POSTS_DEFAULT): Promise<ToolDetail | null> {
  const [tool, aliases, posts, count] = await db.batch([
    db.prepare("SELECT id, slug, name, description, category, tags, homepage_url, github_repo, is_open_source, status, first_seen_at, last_post_at FROM tools WHERE id = ?").bind(id),
    db
      .prepare(
        `SELECT a.kind, a.value, EXISTS (
           SELECT 1 FROM tool_merges m, json_each(m.moved_aliases) j
           WHERE m.into_tool_id = a.tool_id AND m.undone_at IS NULL
             AND j.value ->> '$.kind' = a.kind AND j.value ->> '$.value' = a.value
         ) AS via_merge
         FROM tool_aliases a WHERE a.tool_id = ?
         ORDER BY CASE a.kind WHEN 'repo' THEN 0 WHEN 'domain' THEN 1 ELSE 2 END, a.value`,
      )
      .bind(id),
    db
      .prepare("SELECT id, title, source, url, posted_at, post_type, status FROM posts WHERE tool_id = ? ORDER BY posted_at DESC, id DESC LIMIT ?")
      .bind(id, postLimit),
    db.prepare("SELECT count(*) AS n FROM posts WHERE tool_id = ?").bind(id),
  ]);
  const row = tool!.results[0] as (Omit<ToolDetail, "tags" | "aliases" | "posts" | "postCount"> & { tags: string }) | undefined;
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags) as string[],
    aliases: (aliases!.results as (Omit<ToolDetail["aliases"][number], "via_merge"> & { via_merge: number })[]).map((a) => ({ ...a, via_merge: a.via_merge === 1 })),
    posts: posts!.results as ToolDetail["posts"],
    postCount: (count!.results[0] as { n: number }).n,
  };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Edit form -> validated tool fields. Throws ToolError with a message for the form. */
export async function parseToolForm(db: D1Database, form: FormData) {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const [categories, tagGroups] = await Promise.all([getSetting(db, "categories"), getSetting(db, "tags")]);
  const vocabulary = tagSlugs(tagGroups);

  const name = str("name");
  if (!name) throw new ToolError("Name can't be empty.");
  const slug = str("slug").toLowerCase();
  if (!SLUG.test(slug)) throw new ToolError("Slug: lowercase letters, digits and single hyphens.");
  const description = str("description");
  if (description.length > 140) throw new ToolError(`Description is ${description.length} characters; keep it under 140.`);
  const category = str("category");
  if (!categories.includes(category)) throw new ToolError("Pick a category from the list.");
  const tags = [...new Set(form.getAll("tags").map(String))].filter((t) => vocabulary.includes(t));
  const homepage = str("homepage_url");
  const homepage_url = homepage ? normalizeHomepage(homepage) : null;
  if (homepage && !homepage_url) throw new ToolError("Homepage must be an http(s) URL.");
  const repo = str("github_repo");
  const github_repo = repo ? normalizeGithubRepo(repo) : null;
  if (repo && !github_repo) throw new ToolError('GitHub repo must look like "owner/repo" or a github.com link.');
  const open = str("is_open_source");
  return { name, slug, description: description || null, category, tags, homepage_url, github_repo, is_open_source: open === "true" ? 1 : open === "false" ? 0 : null };
}

/** Whose alias is this, if not this tool's? */
async function aliasOwner(db: D1Database, kind: string, value: string, toolId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT t.name FROM tool_aliases a JOIN tools t ON t.id = a.tool_id WHERE a.kind = ? AND a.value = ? AND a.tool_id != ?")
    .bind(kind, value, toolId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

/**
 * Saves the edit form. A new repo, homepage domain or name also becomes an alias, so
 * future posts resolve here; if another tool already owns it, the save is refused
 * (merge the two tools instead).
 */
export async function updateTool(db: D1Database, id: number, form: FormData): Promise<void> {
  const v = await parseToolForm(db, form);
  const taken = await db.prepare("SELECT 1 FROM tools WHERE slug = ? AND id != ?").bind(v.slug, id).first();
  if (taken) throw new ToolError(`The slug "${v.slug}" is already used by another tool.`);

  const newAliases: [string, string][] = [];
  if (v.github_repo) newAliases.push(["repo", v.github_repo]);
  const host = v.homepage_url ? hostOf(v.homepage_url) : null;
  if (host && !isGenericHost(host)) newAliases.push(["domain", host]);
  const normalized = normalizeToolName(v.name);
  if (normalized) newAliases.push(["name", normalized]);
  for (const [kind, value] of newAliases) {
    const owner = await aliasOwner(db, kind, value, id);
    if (owner) throw new ToolError(`${value} already belongs to ${owner}. Merge the two tools instead.`);
  }

  await db.batch([
    db
      .prepare(
        `UPDATE tools SET name = ?, slug = ?, description = ?, category = ?, tags = ?, homepage_url = ?, github_repo = ?, is_open_source = ?
         WHERE id = ?`,
      )
      .bind(v.name, v.slug, v.description, v.category, JSON.stringify(v.tags), v.homepage_url, v.github_repo, v.is_open_source, id),
    ...newAliases.map(([kind, value]) => db.prepare("INSERT OR IGNORE INTO tool_aliases (tool_id, kind, value) VALUES (?, ?, ?)").bind(id, kind, value)),
  ]);
}

/** Normalizes an alias the way the resolver stores it. */
export function normalizeAlias(kind: string, raw: string): { kind: "repo" | "domain" | "name"; value: string } {
  const value = raw.trim();
  if (kind === "repo") {
    const repo = normalizeGithubRepo(value);
    if (!repo) throw new ToolError('A repo alias looks like "owner/repo" or a github.com link.');
    return { kind, value: repo };
  }
  if (kind === "domain") {
    const host = hostOf(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    if (!host) throw new ToolError("A domain alias looks like example.dev.");
    if (isGenericHost(host)) throw new ToolError(`${host} is a shared host (like github.io); it can't identify one tool.`);
    return { kind, value: host };
  }
  if (kind === "name") {
    const name = normalizeToolName(value);
    if (!name) throw new ToolError("A name alias needs letters or digits.");
    return { kind, value: name };
  }
  throw new ToolError("Unknown alias kind.");
}

export async function addAlias(db: D1Database, id: number, kind: string, raw: string): Promise<void> {
  const alias = normalizeAlias(kind, raw);
  const owner = await aliasOwner(db, alias.kind, alias.value, id);
  if (owner) throw new ToolError(`${alias.value} already belongs to ${owner}. Merge the two tools instead.`);
  await db.prepare("INSERT OR IGNORE INTO tool_aliases (tool_id, kind, value) VALUES (?, ?, ?)").bind(id, alias.kind, alias.value).run();
}

export async function removeAlias(db: D1Database, id: number, kind: string, value: string): Promise<void> {
  await db.prepare("DELETE FROM tool_aliases WHERE tool_id = ? AND kind = ? AND value = ?").bind(id, kind, value).run();
}

/**
 * Hide: the tool leaves public pages; its aliases stay, so new posts about it still
 * resolve to it and stay hidden. Unhide: back to published if any of its posts is
 * published, otherwise queued.
 */
export async function setHidden(db: D1Database, id: number, hidden: boolean): Promise<void> {
  if (hidden) {
    await db.prepare("UPDATE tools SET status = 'hidden' WHERE id = ?").bind(id).run();
    return;
  }
  const merged = await db.prepare("SELECT 1 FROM tool_merges WHERE from_tool_id = ? AND undone_at IS NULL").bind(id).first();
  if (merged) throw new ToolError("This tool was merged into another one. Split the merge to bring it back.");
  await db
    .prepare(
      `UPDATE tools SET status = CASE WHEN EXISTS (SELECT 1 FROM posts p WHERE p.tool_id = tools.id AND p.status = 'published')
         THEN 'published' ELSE 'queued' END
       WHERE id = ? AND status = 'hidden'`,
    )
    .bind(id)
    .run();
}

export interface MergePreview {
  from: { id: number; name: string };
  into: { id: number; name: string; status: ToolStatus };
  posts: { id: number; title: string }[];
  aliases: { kind: string; value: string }[];
}

/** An active (not undone) merge that took this tool away, if any. */
export async function mergedInto(db: D1Database, id: number): Promise<{ merge_id: number; id: number; name: string } | null> {
  return db
    .prepare(
      `SELECT m.id AS merge_id, t.id, t.name FROM tool_merges m JOIN tools t ON t.id = m.into_tool_id
       WHERE m.from_tool_id = ? AND m.undone_at IS NULL ORDER BY m.id DESC LIMIT 1`,
    )
    .bind(id)
    .first<{ merge_id: number; id: number; name: string }>();
}

export async function mergePreview(db: D1Database, fromId: number, intoId: number): Promise<MergePreview> {
  if (fromId === intoId) throw new ToolError("Pick a different tool to merge into.");
  const [from, into, posts, aliases] = await db.batch([
    db.prepare("SELECT id, name FROM tools WHERE id = ?").bind(fromId),
    db.prepare("SELECT id, name, status FROM tools WHERE id = ?").bind(intoId),
    db.prepare("SELECT id, title FROM posts WHERE tool_id = ? ORDER BY posted_at DESC, id DESC").bind(fromId),
    db.prepare("SELECT kind, value FROM tool_aliases WHERE tool_id = ? ORDER BY kind, value").bind(fromId),
  ]);
  const f = from!.results[0] as MergePreview["from"] | undefined;
  const i = into!.results[0] as MergePreview["into"] | undefined;
  if (!f || !i) throw new ToolError("Tool not found.");
  if (await mergedInto(db, fromId)) throw new ToolError(`${f.name} was already merged into another tool.`);
  if (await mergedInto(db, intoId)) throw new ToolError(`${i.name} was merged into another tool; merge into that one instead.`);
  return { from: f, into: i, posts: posts!.results as MergePreview["posts"], aliases: aliases!.results as MergePreview["aliases"] };
}

/**
 * Merges `fromId` into `intoId` as one transaction: posts and aliases move, the merged
 * tool is hidden (its public page will redirect to the target), and the target picks up
 * blank fields, tags, dates and published status. The tool_merges row records what
 * moved so splitMerge can undo it.
 */
export async function mergeTools(db: D1Database, fromId: number, intoId: number): Promise<number> {
  const p = await mergePreview(db, fromId, intoId);
  const from = await db.prepare("SELECT status, tags FROM tools WHERE id = ?").bind(fromId).first<{ status: string; tags: string }>();
  const [, , , inserted] = await db.batch([
    db.prepare("UPDATE posts SET tool_id = ?1 WHERE tool_id = ?2").bind(intoId, fromId),
    db.prepare("UPDATE tool_aliases SET tool_id = ?1 WHERE tool_id = ?2").bind(intoId, fromId),
    db
      .prepare(
        `UPDATE tools SET
           github_repo = coalesce(tools.github_repo, f.github_repo),
           homepage_url = coalesce(tools.homepage_url, f.homepage_url),
           description = coalesce(tools.description, f.description),
           category = coalesce(tools.category, f.category),
           is_open_source = coalesce(tools.is_open_source, f.is_open_source),
           tags = (SELECT json_group_array(DISTINCT value) FROM (SELECT value FROM json_each(tools.tags) UNION SELECT value FROM json_each(f.tags))),
           first_seen_at = min(tools.first_seen_at, f.first_seen_at),
           last_post_at = (SELECT max(p.posted_at) FROM posts p WHERE p.tool_id = tools.id),
           is_active = 1,
           status = CASE WHEN tools.status = 'queued' AND EXISTS (SELECT 1 FROM posts p WHERE p.tool_id = tools.id AND p.status = 'published')
             THEN 'published' ELSE tools.status END
         FROM (SELECT * FROM tools WHERE id = ?2) AS f
         WHERE tools.id = ?1`,
      )
      .bind(intoId, fromId),
    db
      .prepare("INSERT INTO tool_merges (from_tool_id, into_tool_id, moved_aliases, moved_posts, from_status) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(fromId, intoId, JSON.stringify(p.aliases), JSON.stringify(p.posts.map((x) => x.id)), from!.status),
    db.prepare("UPDATE tools SET status = 'hidden', is_active = 0 WHERE id = ?").bind(fromId),
  ]);
  return (inserted!.results[0] as { id: number }).id;
}

export interface MergeRecord {
  id: number;
  from_tool_id: number;
  from_name: string;
  merged_at: string;
  posts: number;
  aliases: number;
}

/** Active merges into this tool, newest first (for "Split back out"). */
export async function mergeHistory(db: D1Database, intoId: number): Promise<MergeRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.from_tool_id, t.name AS from_name, m.merged_at,
         json_array_length(m.moved_posts) AS posts, json_array_length(m.moved_aliases) AS aliases
       FROM tool_merges m JOIN tools t ON t.id = m.from_tool_id
       WHERE m.into_tool_id = ? AND m.undone_at IS NULL ORDER BY m.id DESC`,
    )
    .bind(intoId)
    .all<MergeRecord>();
  return results;
}

/**
 * Undoes a merge: posts and aliases that are still on the target go back, and the
 * merged tool gets its old status back. Anything moved on since (to a third tool, or
 * an alias removed) stays where it is. Returns how many posts came back.
 */
export async function splitMerge(db: D1Database, mergeId: number): Promise<{ fromId: number; posts: number }> {
  const m = await db
    .prepare("SELECT from_tool_id, into_tool_id, moved_posts, moved_aliases, from_status FROM tool_merges WHERE id = ? AND undone_at IS NULL")
    .bind(mergeId)
    .first<{ from_tool_id: number; into_tool_id: number; moved_posts: string; moved_aliases: string; from_status: string | null }>();
  if (!m) throw new ToolError("That merge was already split or doesn't exist.");
  const [posts] = await db.batch([
    db
      .prepare("UPDATE posts SET tool_id = ?1 WHERE tool_id = ?2 AND id IN (SELECT value FROM json_each(?3))")
      .bind(m.from_tool_id, m.into_tool_id, m.moved_posts),
    db
      .prepare(
        `UPDATE tool_aliases SET tool_id = ?1
         WHERE tool_id = ?2 AND EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.kind') = tool_aliases.kind AND json_extract(j.value, '$.value') = tool_aliases.value)`,
      )
      .bind(m.from_tool_id, m.into_tool_id, m.moved_aliases),
    db
      .prepare("UPDATE tools SET status = ?, is_active = 1, last_post_at = (SELECT max(posted_at) FROM posts WHERE tool_id = tools.id) WHERE id = ?")
      .bind(m.from_status ?? "queued", m.from_tool_id),
    db.prepare("UPDATE tools SET last_post_at = (SELECT max(posted_at) FROM posts WHERE tool_id = tools.id) WHERE id = ?").bind(m.into_tool_id),
    db.prepare("UPDATE tool_merges SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(mergeId),
  ]);
  return { fromId: m.from_tool_id, posts: posts!.meta.changes };
}
