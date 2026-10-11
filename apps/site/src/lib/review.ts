import { type Classification, type TagGroups, classificationSchema, getSetting, resolveTool, tagSlugs } from "@slop-bucket/core";

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
}

export interface ToolSummary {
  id: number;
  name: string;
  slug: string;
  status: string;
  category: string | null;
  posts: number;
}

export interface QueueItem {
  post: QueuePost;
  classification: Record<string, unknown> | null;
  tool: ToolSummary | null;
}

const TOOL_SUMMARY = `SELECT t.id, t.name, t.slug, t.status, t.category,
  (SELECT count(*) FROM posts p WHERE p.tool_id = t.id) AS posts FROM tools t`;

export async function queueCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT count(*) AS n FROM posts WHERE status = 'queued'").first<{ n: number }>();
  return row?.n ?? 0;
}

/** The next queued post after `afterId`, wrapping to the oldest; null when the queue is empty. */
export async function nextQueuedId(db: D1Database, afterId = 0): Promise<number | null> {
  const next = await db
    .prepare("SELECT id FROM posts WHERE status = 'queued' AND id > ? ORDER BY id LIMIT 1")
    .bind(afterId)
    .first<{ id: number }>();
  if (next) return next.id;
  const first = await db.prepare("SELECT id FROM posts WHERE status = 'queued' ORDER BY id LIMIT 1").first<{ id: number }>();
  return first?.id ?? null;
}

export async function getQueueItem(db: D1Database, id: number): Promise<QueueItem | null> {
  const post = await db
    .prepare(
      `SELECT id, source, url, title, author, posted_at, status, confidence, tool_id, classification, raw_output
       FROM posts WHERE id = ?`,
    )
    .bind(id)
    .first<QueuePost>();
  if (!post) return null;
  const tool = post.tool_id ? await db.prepare(`${TOOL_SUMMARY} WHERE t.id = ?`).bind(post.tool_id).first<ToolSummary>() : null;
  return { post, classification: post.classification ? JSON.parse(post.classification) : null, tool };
}

/**
 * True when the post's tool exists only because of this post: the resolver found
 * no repo, domain or name to match, so classifying the post created it.
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
