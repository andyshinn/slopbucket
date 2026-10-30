import type { FetchJob, Source } from "./jobs.ts";

/** Sources that have an adapter in the ingest Worker (a test there keeps this in sync). */
export const ENABLED_SOURCES = ["hn", "lobsters", "github"] as const satisfies readonly Source[];

/** Sources whose backfill fans out into one fetch job per day (the rest run as one job). */
export const WINDOWED_SOURCES = ["hn", "github"] as const satisfies readonly Source[];

const DAY = 86_400_000;

/** How many fetch runs a backfill of `days` days produces (the ingest Worker fans out windowed sources over 2 days). */
export function backfillRunCount(sources: readonly Source[], days: number): number {
  return sources.reduce((n, s) => n + ((WINDOWED_SOURCES as readonly string[]).includes(s) && days > 2 ? days : 1), 0);
}

/** Fetch jobs for a "run now" (mode manual) or a backfill of `days` days, one per source. */
export function fetchJobs(sources: readonly Source[], mode: "manual" | "backfill", options: { days?: number; now?: number } = {}): FetchJob[] {
  const now = options.now ?? Date.now();
  return sources.map((source) =>
    mode === "backfill"
      ? { kind: "fetch", source, mode, since: new Date(now - (options.days ?? 90) * DAY).toISOString(), until: new Date(now).toISOString() }
      : { kind: "fetch", source, mode },
  );
}

/** Queued posts nobody has acted on: the posts re-classify and publish-confident may change. */
const UNREVIEWED_QUEUED = "status = 'queued' AND id NOT IN (SELECT post_id FROM review_decisions)";

const ORPHAN_TOOL = `t.status = 'queued'
    AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.tool_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM tool_merges m WHERE m.from_tool_id = t.id OR m.into_tool_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.tool_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM repo_snapshots s WHERE s.tool_id = t.id)`;

/**
 * Re-classification after a classifier change: queued posts nobody has reviewed go
 * back to `pending`, and the tools only they had created are removed. Posts with any
 * review decision, and tools that are published or used elsewhere, are untouched.
 * Used by the admin status panel and by ops.yml (which writes these to a .sql file).
 */
export const RESET_UNREVIEWED_QUEUED_SQL = [
  `UPDATE posts
  SET status = 'pending', classification = NULL, confidence = NULL, raw_output = NULL,
      tool_id = NULL, post_type = NULL, version = NULL, classified_at = NULL
  WHERE ${UNREVIEWED_QUEUED}`,
  `DELETE FROM tool_aliases WHERE tool_id IN (SELECT t.id FROM tools t WHERE ${ORPHAN_TOOL})`,
  `DELETE FROM tools WHERE id IN (SELECT t.id FROM tools t WHERE ${ORPHAN_TOOL})`,
];

/**
 * Dropped posts whose classification came from a model other than the current
 * `model_id` (or from before the model was recorded). After a model change, the
 * old model's drops may hide real tools; posts judged by the current model are kept.
 */
const OLD_MODEL_DROP = `status = 'dropped'
    AND json_extract(classification, '$.model') IS NOT (SELECT json_extract(value, '$') FROM settings WHERE key = 'model_id')`;

/** Optional extra reset step: old-model drops go back to `pending` too. Used by the panel and ops.yml. */
export const RESET_OLD_MODEL_DROPS_SQL = `UPDATE posts
  SET status = 'pending', classification = NULL, confidence = NULL, raw_output = NULL,
      post_type = NULL, version = NULL, drop_reason = NULL, classified_at = NULL
  WHERE ${OLD_MODEL_DROP}`;

/** How many posts and tools a reset would touch (for the confirmation screen). */
export const RESET_PREVIEW_SQL = `SELECT
  (SELECT count(*) FROM posts WHERE ${UNREVIEWED_QUEUED}) AS posts,
  (SELECT count(*) FROM posts WHERE status = 'queued' AND id IN (SELECT post_id FROM review_decisions)) AS kept,
  (SELECT count(*) FROM posts WHERE ${OLD_MODEL_DROP}) AS old_drops`;

/**
 * Runs the reset as one transaction and returns the IDs of every post now waiting for
 * classification. With `includeOldDrops`, posts dropped by an older model are reset too.
 */
export async function resetUnreviewedQueued(db: D1Database, options: { includeOldDrops?: boolean } = {}): Promise<number[]> {
  const statements = [...RESET_UNREVIEWED_QUEUED_SQL, ...(options.includeOldDrops ? [RESET_OLD_MODEL_DROPS_SQL] : [])];
  await db.batch(statements.map((sql) => db.prepare(sql)));
  const { results } = await db.prepare("SELECT id FROM posts WHERE status = 'pending' ORDER BY id").all<{ id: number }>();
  return results.map((r) => r.id);
}

/**
 * Whether a classified post publishes without review: confidence at or above
 * `review_threshold`, and a category other than `other`. A threshold of 1 means
 * everything is reviewed, even confidence 1.0. The classify job and
 * PUBLISH_CONFIDENT_SQL both follow this rule.
 */
export function autoPublishes(threshold: number, confidence: number, category: string): boolean {
  return threshold < 1 && confidence >= threshold && category !== "other";
}

const setting = (key: string) => `(SELECT json_extract(value, '$') FROM settings WHERE key = '${key}')`;

/**
 * Unreviewed queued posts that autoPublishes() would publish under today's settings,
 * judged from their stored classification. A category no longer in the list (it was
 * removed after the post was classified) waits for review or a re-classify instead.
 */
const CONFIDENT_QUEUED = `${UNREVIEWED_QUEUED} AND tool_id IS NOT NULL AND confidence IS NOT NULL
    AND ${setting("review_threshold")} < 1 AND confidence >= ${setting("review_threshold")}
    AND json_extract(classification, '$.category') != 'other'
    AND json_extract(classification, '$.category') IN (SELECT value FROM json_each((SELECT value FROM settings WHERE key = 'categories')))`;

/**
 * Applies the current review threshold to the queue without calling the model: confident
 * unreviewed posts publish, and so do their tools unless hidden (as in the classify job).
 * Tools first, while the posts still read as queued. Records no review decisions, so
 * these posts don't count as reviewed. Used by the admin status panel and ops.yml.
 */
export const PUBLISH_CONFIDENT_SQL = [
  `UPDATE tools SET status = 'published'
  WHERE status = 'queued' AND id IN (SELECT tool_id FROM posts WHERE ${CONFIDENT_QUEUED})`,
  `UPDATE posts SET status = 'published' WHERE ${CONFIDENT_QUEUED}`,
];

/** The threshold, and how many posts and tools PUBLISH_CONFIDENT_SQL would publish (for the confirmation screen). */
export const PUBLISH_CONFIDENT_PREVIEW_SQL = `SELECT
  ${setting("review_threshold")} AS threshold,
  (SELECT count(*) FROM posts WHERE ${CONFIDENT_QUEUED}) AS posts,
  (SELECT count(*) FROM tools WHERE status = 'queued' AND id IN (SELECT tool_id FROM posts WHERE ${CONFIDENT_QUEUED})) AS tools`;

export interface PublishConfidentPreview {
  threshold: number;
  /** Unreviewed queued posts at or above the threshold. */
  posts: number;
  /** Queued tools that publish with them. */
  tools: number;
}

export async function publishConfidentPreview(db: D1Database): Promise<PublishConfidentPreview> {
  const r = await db.prepare(PUBLISH_CONFIDENT_PREVIEW_SQL).first<PublishConfidentPreview>();
  return { threshold: r?.threshold ?? 1, posts: r?.posts ?? 0, tools: r?.tools ?? 0 };
}

/** Runs PUBLISH_CONFIDENT_SQL as one transaction; returns how many posts and tools were published. */
export async function publishConfidentQueued(db: D1Database): Promise<{ posts: number; tools: number }> {
  const [tools, posts] = await db.batch(PUBLISH_CONFIDENT_SQL.map((sql) => db.prepare(sql)));
  return { posts: posts?.meta.changes ?? 0, tools: tools?.meta.changes ?? 0 };
}
