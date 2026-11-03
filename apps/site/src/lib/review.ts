import {
  type Classification, type Language, type TagGroups, LANGUAGES, LANGUAGE_CODES, classificationSchema, getSetting, latestStarsSql, lowStarToolSql, resolveTool, tagSlugs,
} from "@slop-bucket/core";

export interface QueuePost {
  id: number;
  source: string;
  url: string;
  title: string;
  author: string | null;
  posted_at: string;
  status: string;
  confidence: number | null;
  tool_id: number | null;
  classification: string | null;
  raw_output: string | null;
  /** Detected spoken language (packages/core language.ts); null until detected. */
  language: string | null;
}

export interface ToolSummary {
  id: number;
  name: string;
  slug: string;
  status: string;
  category: string | null;
  posts: number;
  github_repo: string | null;
  /** Stars in the latest repo snapshot; null without a repo or a snapshot. */
  stars: number | null;
  /** Repo under github_min_stars, or not snapshotted yet (lowStarToolSql): never publishes without review. */
  low_stars: 0 | 1;
}

export interface QueueItem {
  post: QueuePost;
  classification: Record<string, unknown> | null;
  tool: ToolSummary | null;
}

const TOOL_SUMMARY = `SELECT t.id, t.name, t.slug, t.status, t.category,
  (SELECT count(*) FROM posts p WHERE p.tool_id = t.id) AS posts, t.github_repo,
  ${latestStarsSql("t")} AS stars, coalesce(${lowStarToolSql("t")}, 0) AS low_stars FROM tools t`;

// Queue filters, from the filter bar (a bar on desktop, a collapsed panel on
// phones). They ride along in the URL (list links, Edit, Move, and the redirect
// after a decision).
export const QUEUE_SOURCES = ["hn", "lobsters", "github", "producthunt"] as const;
export const CONFIDENCE_BANDS = { high: "90% and up", mid: "70–89%", low: "Under 70% or no score" } as const;
export const QUEUE_ORDERS = { oldest: "Oldest first", newest: "Newest first", lowest: "Lowest confidence first" } as const;
/** Star filter labels, given github_min_stars. "Under" follows lowStarToolSql: a repo with no snapshot yet counts. */
export const starFilterLabels = (minStars: number) => ({ hide: `Hide under ${minStars} stars`, only: `Only under ${minStars} stars` }) as const;
export const STAR_FILTER_KEYS = ["hide", "only"] as const;
export type StarFilter = (typeof STAR_FILTER_KEYS)[number];
export type ConfidenceBand = keyof typeof CONFIDENCE_BANDS;
export type QueueOrder = keyof typeof QUEUE_ORDERS;
export const BAND_KEYS = Object.keys(CONFIDENCE_BANDS) as ConfidenceBand[];
export const ORDER_KEYS = Object.keys(QUEUE_ORDERS) as QueueOrder[];

export interface QueueFilters {
  /** "" for every source. */
  source: (typeof QUEUE_SOURCES)[number] | "";
  /** "" for any confidence. */
  band: ConfidenceBand | "";
  /** "" for any stars; hide or only show posts whose tool's repo is under the star floor. */
  stars: StarFilter | "";
  /** "" for any language; see LanguageFilter. */
  language: LanguageFilter | "";
  order: QueueOrder;
}

/**
 * Language filter values. `en` also matches Unknown (`und`, or not detected yet):
 * those are mostly title-only posts, nearly always English. `non-en` is every
 * detected language but English. Any other code matches that language alone
 * (`und` matches Unknown alone).
 */
export const NON_ENGLISH = "non-en";
export type LanguageFilter = Language | typeof NON_ENGLISH;
export const LANGUAGE_FILTER_KEYS: readonly LanguageFilter[] = [...LANGUAGE_CODES, NON_ENGLISH];
export const languageFilterLabel = (f: LanguageFilter): string => (f === NON_ENGLISH ? "Non-English" : LANGUAGES[f]);

/** Queued posts a language filter matches, from queueLanguages' counts. */
export function languageFilterCount(f: LanguageFilter, counts: Map<string, number>): number {
  const englishOrUnknown = (counts.get("en") ?? 0) + (counts.get("und") ?? 0);
  if (f === "en") return englishOrUnknown;
  if (f === NON_ENGLISH) return [...counts.values()].reduce((a, b) => a + b, 0) - englishOrUnknown;
  return counts.get(f) ?? 0;
}

const DEFAULT_QUEUE_FILTERS: QueueFilters = { source: "", band: "", stars: "", language: "", order: "oldest" };

const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined =>
  allowed.find((a) => a === value);

/** Filters from the URL; unknown values fall back to the defaults (no filter, oldest first). */
export function parseQueueFilters(params: URLSearchParams): QueueFilters {
  return {
    source: oneOf(params.get("source"), QUEUE_SOURCES) ?? DEFAULT_QUEUE_FILTERS.source,
    band: oneOf(params.get("band"), BAND_KEYS) ?? DEFAULT_QUEUE_FILTERS.band,
    stars: oneOf(params.get("stars"), STAR_FILTER_KEYS) ?? DEFAULT_QUEUE_FILTERS.stars,
    language: oneOf(params.get("language"), LANGUAGE_FILTER_KEYS) ?? DEFAULT_QUEUE_FILTERS.language,
    order: oneOf(params.get("order"), ORDER_KEYS) ?? DEFAULT_QUEUE_FILTERS.order,
  };
}

/** The filters as a query string without defaults ("" when none apply), to append to queue links. */
export function queueFilterQuery(f: QueueFilters): string {
  const q = new URLSearchParams();
  if (f.source !== DEFAULT_QUEUE_FILTERS.source) q.set("source", f.source);
  if (f.band !== DEFAULT_QUEUE_FILTERS.band) q.set("band", f.band);
  if (f.stars !== DEFAULT_QUEUE_FILTERS.stars) q.set("stars", f.stars);
  if (f.language !== DEFAULT_QUEUE_FILTERS.language) q.set("language", f.language);
  if (f.order !== DEFAULT_QUEUE_FILTERS.order) q.set("order", f.order);
  return q.toString();
}

/** `path` with the filter query appended. */
export const withFilters = (path: string, f: QueueFilters): string => {
  const q = queueFilterQuery(f);
  return q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
};

const BAND_SQL: Record<ConfidenceBand, string> = {
  high: "p.confidence >= 0.9",
  mid: "p.confidence >= 0.7 AND p.confidence < 0.9",
  low: "(p.confidence IS NULL OR p.confidence < 0.7)",
};
// Sort key (for a table alias) and direction; id breaks ties so every order is total (needed for "next after").
const ORDER_SQL: Record<QueueOrder, { key: (alias: string) => string; dir: "ASC" | "DESC" }> = {
  oldest: { key: (a) => `${a}.id`, dir: "ASC" },
  newest: { key: (a) => `${a}.id`, dir: "DESC" },
  lowest: { key: (a) => `coalesce(${a}.confidence, -1)`, dir: "ASC" },
};

/** The post `p` belongs to a tool whose repo is under the star floor (a post with no tool never does). */
const LOW_STAR_POST = `EXISTS (SELECT 1 FROM tools lt WHERE lt.id = p.tool_id AND ${lowStarToolSql("lt")})`;

/** The filters as conditions on posts `p` ("1" when none apply), not counting the queued status. */
function filterSql(f: QueueFilters): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (f.source) {
    parts.push("p.source = ?");
    binds.push(f.source);
  }
  if (f.band) parts.push(BAND_SQL[f.band]);
  if (f.stars) parts.push(`${f.stars === "hide" ? "NOT " : ""}${LOW_STAR_POST}`);
  if (f.language === "en") parts.push("coalesce(p.language, 'und') IN ('en', 'und')");
  else if (f.language === NON_ENGLISH) parts.push("coalesce(p.language, 'und') NOT IN ('en', 'und')");
  else if (f.language) {
    parts.push("coalesce(p.language, 'und') = ?");
    binds.push(f.language);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", binds };
}

function queueWhere(f: QueueFilters): { where: string; binds: unknown[] } {
  const { sql, binds } = filterSql(f);
  return { where: `p.status = 'queued' AND ${sql}`, binds };
}

const orderBy = (f: QueueFilters) => {
  const { key, dir } = ORDER_SQL[f.order];
  return `ORDER BY ${key("p")} ${dir}, p.id ${dir}`;
};

/** All queued posts, and those matching the filters, in one query. */
export async function queueCounts(db: D1Database, f: QueueFilters = DEFAULT_QUEUE_FILTERS): Promise<{ total: number; matching: number }> {
  const { sql, binds } = filterSql(f);
  const row = await db
    .prepare(`SELECT count(*) AS total, count(CASE WHEN ${sql} THEN 1 END) AS matching FROM posts p WHERE p.status = 'queued'`)
    .bind(...binds)
    .first<{ total: number; matching: number }>();
  return { total: row?.total ?? 0, matching: row?.matching ?? 0 };
}

/** Queued posts per detected language (`und` includes posts not detected yet), for the language filter. */
export async function queueLanguages(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT coalesce(language, 'und') AS language, count(*) AS n FROM posts WHERE status = 'queued' GROUP BY 1")
    .all<{ language: string; n: number }>();
  return new Map(results.map((r) => [r.language, r.n]));
}

/**
 * The next queued post after `afterId` in the filters' order, wrapping to the
 * first; null when nothing matches. `afterId` may be a post that was just
 * reviewed: its sort key is read from the row, whatever its status now. If the
 * row is gone, the comparison is NULL and this falls through to the first.
 */
export async function nextQueuedId(db: D1Database, afterId = 0, f: QueueFilters = DEFAULT_QUEUE_FILTERS): Promise<number | null> {
  const { where, binds } = queueWhere(f);
  const { key, dir } = ORDER_SQL[f.order];
  if (afterId > 0) {
    const next = await db
      .prepare(
        `SELECT p.id FROM posts p WHERE ${where}
         AND (${key("p")}, p.id) ${dir === "ASC" ? ">" : "<"} (SELECT ${key("cur")}, cur.id FROM posts cur WHERE cur.id = ?)
         ${orderBy(f)} LIMIT 1`,
      )
      .bind(...binds, afterId)
      .first<{ id: number }>();
    if (next) return next.id;
  }
  const first = await db.prepare(`SELECT p.id FROM posts p WHERE ${where} ${orderBy(f)} LIMIT 1`).bind(...binds).first<{ id: number }>();
  return first?.id ?? null;
}

export interface QueueListItem {
  id: number;
  source: string;
  title: string;
  posted_at: string;
  confidence: number | null;
  tool_name: string | null;
  /** Same test as isNewTool: the only post of a still-queued tool. */
  new_tool: 0 | 1;
  /** As on ToolSummary: null without a tool, repo or snapshot. */
  stars: number | null;
  low_stars: 0 | 1;
  language: string | null;
}

export const QUEUE_LIST_SIZE = 50;

/** The first queued posts in the filters' order, for the desktop list. */
export async function listQueue(db: D1Database, f: QueueFilters, limit = QUEUE_LIST_SIZE): Promise<QueueListItem[]> {
  const { where, binds } = queueWhere(f);
  const { results } = await db
    .prepare(
      `SELECT p.id, p.source, p.title, p.posted_at, p.confidence, t.name AS tool_name,
         coalesce(t.status = 'queued' AND (SELECT count(*) FROM posts p2 WHERE p2.tool_id = t.id) <= 1, 0) AS new_tool,
         ${latestStarsSql("t")} AS stars, coalesce(${lowStarToolSql("t")}, 0) AS low_stars, p.language
       FROM posts p LEFT JOIN tools t ON t.id = p.tool_id
       WHERE ${where} ${orderBy(f)} LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<QueueListItem>();
  return results;
}

export async function getQueueItem(db: D1Database, id: number): Promise<QueueItem | null> {
  const post = await db
    .prepare(
      `SELECT id, source, url, title, author, posted_at, status, confidence, tool_id, classification, raw_output, language
       FROM posts WHERE id = ?`,
    )
    .bind(id)
    .first<QueuePost>();
  if (!post) return null;
  const tool = post.tool_id ? await db.prepare(`${TOOL_SUMMARY} WHERE t.id = ?`).bind(post.tool_id).first<ToolSummary>() : null;
  return { post, classification: post.classification ? JSON.parse(post.classification) : null, tool };
}

/**
 * True when this post is the only one linked to a still-queued tool (posts of
 * any status count). Usually the resolver created the tool for this post, but
 * a hand-moved post can look the same, so the page says only what this checks.
 */
export const isNewTool = (tool: ToolSummary): boolean => tool.posts <= 1 && tool.status === "queued";

export interface TagChip {
  slug: string;
  label: string;
  /** False for tags outside the current vocabulary (classified before a vocabulary change). */
  known: boolean;
}

/** A classification's tags as chips, labeled from the vocabulary. */
export function tagChips(tags: unknown, groups: TagGroups): TagChip[] {
  if (!Array.isArray(tags)) return [];
  const labels = new Map(groups.flatMap((g) => g.tags.map((t) => [t.slug, t.label] as const)));
  return [...new Set(tags.filter((t): t is string => typeof t === "string" && t !== ""))].map((slug) => {
    const label = labels.get(slug);
    return { slug, label: label ?? slug, known: label !== undefined };
  });
}

/** Thrown for actions that do not apply to the post in its current state. */
export class ReviewError extends Error {}

async function requireQueued(db: D1Database, id: number): Promise<QueuePost> {
  const item = await getQueueItem(db, id);
  if (!item) throw new ReviewError("Post not found.");
  if (item.post.status !== "queued") throw new ReviewError(`Post is already ${item.post.status}.`);
  return item.post;
}

/**
 * First statement of every review batch. D1 runs a batch as one transaction, so
 * if another submission already moved the post out of `queued` (a double tap, a
 * second tab), this violates the posts.status CHECK constraint and the whole
 * batch rolls back: exactly one decision wins.
 */
function claimQueued(db: D1Database, postId: number) {
  return db
    .prepare("UPDATE posts SET status = CASE WHEN status = 'queued' THEN 'queued' ELSE 'already-reviewed' END WHERE id = ?")
    .bind(postId);
}

/** Runs a review batch behind claimQueued; a lost race becomes a ReviewError. */
async function reviewBatch(db: D1Database, postId: number, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch([claimQueued(db, postId), ...statements]);
  } catch (err) {
    if (String(err).includes("CHECK constraint failed")) throw new ReviewError("This post was already reviewed.");
    throw err;
  }
}

function decision(db: D1Database, postId: number, kind: string, corrected: Record<string, unknown> | null, useInPrompt: boolean) {
  return db
    .prepare("INSERT INTO review_decisions (post_id, decision, corrected_fields, use_in_prompt) VALUES (?, ?, ?, ?)")
    .bind(postId, kind, corrected ? JSON.stringify(corrected) : null, useInPrompt ? 1 : 0);
}

function publish(db: D1Database, postId: number, toolId: number) {
  return [
    db.prepare("UPDATE posts SET status = 'published', tool_id = ? WHERE id = ?").bind(toolId, postId),
    // A hidden tool stays hidden; hiding is a deliberate admin choice.
    db.prepare("UPDATE tools SET status = 'published' WHERE id = ? AND status = 'queued'").bind(toolId),
  ];
}

export async function approvePost(db: D1Database, id: number, useInPrompt: boolean): Promise<void> {
  const post = await requireQueued(db, id);
  if (!post.tool_id || !post.classification) {
    throw new ReviewError("This post has no tool yet. Use Edit to fill in the fields, then approve.");
  }
  await reviewBatch(db, id, [...publish(db, id, post.tool_id), decision(db, id, "approve", null, useInPrompt)]);
}

export async function rejectPost(db: D1Database, id: number, useInPrompt: boolean): Promise<void> {
  await requireQueued(db, id);
  // As a few-shot example, a rejection teaches the model "not an AI coding tool".
  await reviewBatch(db, id, [
    db.prepare("UPDATE posts SET status = 'rejected' WHERE id = ?").bind(id),
    decision(db, id, "reject", { is_ai_dev_tool: false }, useInPrompt),
  ]);
}

export async function reassignPost(db: D1Database, id: number, toolId: number): Promise<void> {
  await requireQueued(db, id);
  const tool = await db.prepare("SELECT id FROM tools WHERE id = ?").bind(toolId).first();
  if (!tool) throw new ReviewError("Tool not found.");
  await reviewBatch(db, id, [
    db.prepare("UPDATE posts SET tool_id = ? WHERE id = ?").bind(toolId, id),
    decision(db, id, "reassign", { tool_id: toolId }, false),
  ]);
}

export const EDITABLE_FIELDS = [
  "is_ai_dev_tool", "post_type", "tool_name", "homepage_url", "github_repo", "version",
  "category", "tags", "is_open_source", "description",
] as const;
export type EditableFields = Pick<Classification, (typeof EDITABLE_FIELDS)[number]>;

const EMPTY: Record<string, unknown> = {
  is_ai_dev_tool: true, post_type: "launch", tool_name: "", homepage_url: null, github_repo: null, version: null,
  category: "other", tags: [], is_open_source: false, description: "", confidence: 1,
};

/**
 * Applies the reviewer's corrections and approves, or rejects if they mark it
 * out of scope. Corrections are stored in review_decisions (the model's own
 * output stays in posts.classification) so they can serve as few-shot examples.
 * Changing the tool's name, repo or homepage re-resolves which tool the post belongs to.
 */
export async function editPost(db: D1Database, id: number, input: Record<string, unknown>, useInPrompt: boolean): Promise<"approved" | "rejected"> {
  const post = await requireQueued(db, id);
  const [categories, tagGroups] = await Promise.all([getSetting(db, "categories"), getSetting(db, "tags")]);
  const original: Record<string, unknown> = post.classification ? JSON.parse(post.classification) : {};
  const parsed = classificationSchema(categories, tagSlugs(tagGroups)).safeParse({ ...EMPTY, ...original, ...input, confidence: original.confidence ?? 1 });
  if (!parsed.success) throw new ReviewError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const c = parsed.data;

  const corrected: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (JSON.stringify(c[field]) !== JSON.stringify(original[field] ?? null)) corrected[field] = c[field];
  }

  if (!c.is_ai_dev_tool || c.post_type === "roundup") {
    await reviewBatch(db, id, [
      db.prepare("UPDATE posts SET status = 'rejected', post_type = ? WHERE id = ?").bind(c.post_type, id),
      decision(db, id, "edit", corrected, useInPrompt),
    ]);
    return "rejected";
  }
  if (!c.tool_name && !c.github_repo) throw new ReviewError("Give the tool a name or a GitHub repo.");

  const identityChanged = ["tool_name", "github_repo", "homepage_url"].some((f) => f in corrected);
  // resolveTool also fills *empty* fields of a matched tool from `c` (never overwrites);
  // `c` is the form the reviewer just saved, so that enrichment is intended.
  const toolId = post.tool_id && !identityChanged ? post.tool_id : await resolveTool(db, c, post);

  // Reviewer edits win over model output on the tool, but only for fields they changed.
  const toolUpdates: [string, unknown][] = [];
  // An emptied name (allowed when a repo is given) keeps the existing or repo-derived name.
  if ("tool_name" in corrected && c.tool_name) toolUpdates.push(["name", c.tool_name]);
  if ("description" in corrected) toolUpdates.push(["description", c.description || null]);
  if ("category" in corrected) toolUpdates.push(["category", c.category]);
  if ("homepage_url" in corrected) toolUpdates.push(["homepage_url", c.homepage_url]);
  if ("github_repo" in corrected) toolUpdates.push(["github_repo", c.github_repo]);
  if ("is_open_source" in corrected) toolUpdates.push(["is_open_source", c.is_open_source ? 1 : 0]);
  if ("tags" in corrected) toolUpdates.push(["tags", JSON.stringify(c.tags)]);

  await reviewBatch(db, id, [
    db.prepare("UPDATE posts SET post_type = ?, version = ? WHERE id = ?").bind(c.post_type, c.version, id),
    ...(toolUpdates.length
      ? [
          db
            .prepare(`UPDATE tools SET ${toolUpdates.map(([col]) => `${col} = ?`).join(", ")} WHERE id = ?`)
            .bind(...toolUpdates.map(([, v]) => v), toolId),
        ]
      : []),
    ...publish(db, id, toolId),
    decision(db, id, "edit", corrected, useInPrompt),
  ]);
  return "approved";
}

/** Edit form fields -> classification-shaped values ("" means unset). */
export function parseEditForm(form: FormData): Record<string, unknown> {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const opt = (k: string) => str(k) || null;
  return {
    is_ai_dev_tool: str("is_ai_dev_tool") === "true",
    post_type: str("post_type"),
    tool_name: str("tool_name"),
    homepage_url: opt("homepage_url"),
    github_repo: opt("github_repo"),
    version: opt("version"),
    category: str("category"),
    // One checkbox per vocabulary tag.
    tags: form.getAll("tags").map((t) => String(t).trim()).filter(Boolean),
    is_open_source: str("is_open_source") === "true",
    description: str("description"),
  };
}

/** Full-text search over tool name, description and tags (prefix match on each word). */
export async function searchTools(db: D1Database, query: string, limit = 15): Promise<ToolSummary[]> {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const match = words.map((w) => `"${w}"*`).join(" ");
  const { results } = await db
    .prepare(`${TOOL_SUMMARY} JOIN tools_fts ON tools_fts.rowid = t.id WHERE tools_fts MATCH ? ORDER BY tools_fts.rank LIMIT ?`)
    .bind(match, limit)
    .all<ToolSummary>();
  return results;
}

export async function readArticleText(articles: R2Bucket, postId: number): Promise<string | null> {
  const object = await articles.get(`text/${postId}.txt`);
  return object ? object.text() : null;
}
