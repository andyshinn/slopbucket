import { type Classification, type ClassifyJob, type TagGroups, autoPublishes, classificationSchema, getSetting, resolveTool, tagSlugs } from "@slop-bucket/core";
import { type FewShotExample, classifierFingerprint, classifyPost } from "./classifier.ts";
import { getArticleText } from "./content.ts";
import type { Deps } from "./deps.ts";
import { USER_AGENT } from "./http.ts";

interface PostRow {
  id: number;
  source: string;
  url: string;
  canonical_url: string;
  title: string;
  posted_at: string;
  status: string;
  classification: string | null;
}

export async function runClassifyJob(job: ClassifyJob, deps: Deps): Promise<void> {
  const { db } = deps;
  const post = await db
    .prepare("SELECT id, source, url, canonical_url, title, posted_at, status, classification FROM posts WHERE id = ?")
    .bind(job.post_id)
    .first<PostRow>();
  // Already routed (e.g. a redelivered message): nothing to do.
  if (!post || post.status !== "pending") return;

  const [threshold, minStars, categories, model, reasoningEffort, maxFewShot, tags] = await Promise.all([
    getSetting(db, "review_threshold"),
    getSetting(db, "github_min_stars"),
    getSetting(db, "categories"),
    getSetting(db, "model_id"),
    getSetting(db, "model_reasoning_effort"),
    getSetting(db, "max_fewshot"),
    getSetting(db, "tags"),
  ]);
  const schema = classificationSchema(categories, tagSlugs(tags));
  const parseStored = (json: string | null) => {
    const result = json ? schema.safeParse(JSON.parse(json)) : null;
    return result?.success ? result.data : null;
  };

  // A retry after a failure further down reuses the stored result instead of calling the model again.
  let classification = parseStored(post.classification);
  let via = "stored";

  // Dedupe: the same link was already classified (e.g. cross-posted to HN and lobste.rs).
  // Requires the exact URL, not just the canonical one: a GitHub release link shares
  // its canonical owner/repo URL with the launch post but needs its own type and version.
  // Only reuses a result from the same classifier setup (model, reasoning, prompt and
  // categories), and never for forced jobs (re-classify), which always call the model.
  const classifier = await classifierFingerprint(model, reasoningEffort, categories, tags);
  if (!classification && !job.force) {
    const twin = await db
      .prepare(
        `SELECT classification FROM posts
         WHERE canonical_url = ? AND url = ? AND id != ? AND json_extract(classification, '$.classifier') = ?
         ORDER BY id LIMIT 1`,
      )
      .bind(post.canonical_url, post.url, post.id, classifier)
      .first<{ classification: string }>();
    classification = parseStored(twin?.classification ?? null);
    via = "duplicate_url";
  }

  if (!classification) {
    const text = await getArticleText(post, deps);
    const fewShot = await loadFewShot(db, maxFewShot, categories, tags);
    const result = await classifyPost({ model, categories, tags, post, text, fewShot, reasoningEffort: reasoningEffort || undefined }, deps.ai);
    if (!result.ok) {
      await db
        .prepare("UPDATE posts SET status = 'queued', raw_output = ? WHERE id = ?")
        .bind(JSON.stringify({ raw: result.raw, error: result.error }), post.id)
        .run();
      console.warn(JSON.stringify({ event: "classify_invalid", post_id: post.id, error: result.error }));
      return;
    }
    classification = { ...result.value, model, classifier };
    via = "model";
    await db
      .prepare("UPDATE posts SET classification = ?, confidence = ?, post_type = ?, version = ? WHERE id = ?")
      .bind(JSON.stringify(classification), classification.confidence, classification.post_type, classification.version, post.id)
      .run();
  }

  const outcome = await route(deps, post, classification, threshold, minStars);
  console.log(JSON.stringify({ event: "classified", post_id: post.id, via, ...outcome }));
}

/** Routing rules from docs/DESIGN.md "Routing after classification". */
async function route(deps: Deps, post: PostRow, c: Classification, threshold: number, minStars: number) {
  const { db } = deps;
  const fields = [JSON.stringify(c), c.confidence, c.post_type, c.version] as const;

  // A "tool" the model cannot name (and has no repo for) is an article about AI
  // tools in general, not a post about one specific tool.
  const unnamed = !c.tool_name && !c.github_repo;
  if (!c.is_ai_dev_tool || c.post_type === "roundup" || unnamed) {
    const reason = !c.is_ai_dev_tool ? "not_ai_dev_tool" : c.post_type === "roundup" ? "roundup" : "no_tool_named";
    await db
      .prepare("UPDATE posts SET classification = ?, confidence = ?, post_type = ?, version = ?, status = 'dropped', drop_reason = ? WHERE id = ?")
      .bind(...fields, reason, post.id)
      .run();
    return { status: "dropped", reason };
  }

  const toolId = await resolveTool(db, c, post);
  // The star floor covers repos linked from any source, not only those the GitHub search finds.
  const confident = autoPublishes(threshold, c.confidence, c.category);
  const held = confident && (await belowStarFloor(deps, toolId, minStars));
  const publish = confident && !held;
  const status = publish ? "published" : "queued";
  await db.batch([
    db
      .prepare("UPDATE posts SET classification = ?, confidence = ?, post_type = ?, version = ?, status = ?, tool_id = ? WHERE id = ?")
      .bind(...fields, status, toolId, post.id),
    db
      .prepare(
        `UPDATE tools SET
           last_post_at = max(coalesce(last_post_at, ''), ?1),
           first_seen_at = min(first_seen_at, ?1),
           is_active = 1,
           status = CASE WHEN ?2 AND status = 'queued' THEN 'published' ELSE status END
         WHERE id = ?3`,
      )
      .bind(post.posted_at, publish ? 1 : 0, toolId),
  ]);
  return { status, tool_id: toolId, confidence: c.confidence, ...(held && { held: "github_min_stars" }) };
}

/**
 * Whether the tool's GitHub repo has fewer than `minStars` stars. Unknown counts as
 * under (GitHub didn't answer, or the repo was renamed or deleted), so the post waits
 * for review. Tools without a repo have no floor.
 */
async function belowStarFloor(deps: Deps, toolId: number, minStars: number): Promise<boolean> {
  const tool = await deps.db.prepare("SELECT github_repo FROM tools WHERE id = ?").bind(toolId).first<{ github_repo: string | null }>();
  if (!tool?.github_repo) return false;
  const stars = await repoStars(tool.github_repo, deps);
  return stars === null || stars < minStars;
}

async function repoStars(repo: string, deps: Deps): Promise<number | null> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/vnd.github+json" };
  if (deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;
  try {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET repo -> ${res.status}`);
    const { stargazers_count } = (await res.json()) as { stargazers_count?: unknown };
    if (typeof stargazers_count !== "number") throw new Error("no stargazers_count");
    return stargazers_count;
  } catch (err) {
    console.warn(JSON.stringify({ event: "repo_stars_failed", repo, error: String(err) }));
    return null;
  }
}

/**
 * Review decisions marked "use in prompt", newest first, up to max_fewshot. The
 * example output is the model's classification with the reviewer's corrections
 * applied; for posts whose model output was invalid, the corrections alone (an
 * edit stores every field then). Examples that don't form a complete valid
 * classification are skipped.
 */
export async function loadFewShot(db: D1Database, limit: number, categories: readonly string[], tags: TagGroups): Promise<FewShotExample[]> {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `SELECT p.source, p.title, p.url, p.classification, d.corrected_fields
       FROM review_decisions d JOIN posts p ON p.id = d.post_id
       WHERE d.use_in_prompt = 1
       ORDER BY d.decided_at DESC, d.id DESC LIMIT ?`,
    )
    .bind(limit * 3)
    .all<{ source: string; title: string; url: string; classification: string | null; corrected_fields: string | null }>();
  // Tags outside today's vocabulary drop out of the example (into suggested_tags).
  const schema = classificationSchema(categories, tagSlugs(tags));
  const examples: FewShotExample[] = [];
  for (const r of results) {
    const merged: Record<string, unknown> = {
      confidence: 1,
      ...(r.classification ? JSON.parse(r.classification) : {}),
      ...(r.corrected_fields ? JSON.parse(r.corrected_fields) : {}),
    };
    const parsed = schema.safeParse(merged);
    if (!parsed.success) continue;
    const { model: _m, classifier: _c, ...output } = parsed.data; // bookkeeping, not part of the answer
    examples.push({ post: { source: r.source, title: r.title, url: r.url }, output });
    if (examples.length === limit) break;
  }
  return examples;
}

/**
 * Most posts the daily cron re-enqueues: about a day of classifying at ~12 a
 * minute (~$7 at ~$0.0004 a post); queueing more a day wouldn't classify them
 * faster. Any still pending past this wait for the next day's run.
 */
export const REQUEUE_LIMIT = 17_000;

/**
 * Re-enqueues posts still `pending` an hour after they were stored: their
 * classify job ran out of retries, for example while the AI Gateway spend
 * limit was blocking requests. Runs from the daily cron.
 */
export async function requeueStalePending(db: D1Database, classifyQueue: Queue, limit = REQUEUE_LIMIT): Promise<number> {
  const { results } = await db
    .prepare(
      "SELECT id FROM posts WHERE status = 'pending' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') ORDER BY id LIMIT ?",
    )
    .bind(limit)
    .all<{ id: number }>();
  for (let i = 0; i < results.length; i += 100) {
    const jobs: ClassifyJob[] = results.slice(i, i + 100).map((r) => ({ kind: "classify", post_id: r.id }));
    await classifyQueue.sendBatch(jobs.map((body) => ({ body })));
  }
  return results.length;
}
