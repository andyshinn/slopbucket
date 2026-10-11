import {
  type ClassifyJob,
  ENABLED_SOURCES,
  type FetchJob,
  RESET_PREVIEW_SQL,
  type Source,
  type TrendingJob,
  backfillRunCount,
  fetchJobs,
  resetUnreviewedQueued,
} from "@slop-bucket/core";

export interface SourceRun {
  mode: string;
  started_at: string;
  finished_at: string | null;
  items_fetched: number | null;
  error: string | null;
}

export interface SourceStatus {
  source: Source;
  /** The most recent run of any mode (a backfill shows here too). */
  last: SourceRun | null;
  /**
   * Average items per finished, error-free daily or manual run over the 7 days before
   * the latest finished daily or manual run. Backfill runs cover different spans, so
   * they are left out of the comparison.
   */
  weekAverage: number | null;
  /** The latest finished daily or manual run fetched less than half the weekly average. */
  dropWarning: boolean;
}

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function sendAll<T>(queue: Queue, bodies: T[]): Promise<void> {
  for (let i = 0; i < bodies.length; i += 100) {
    await queue.sendBatch(bodies.slice(i, i + 100).map((body) => ({ body })));
  }
}

export async function sourceStatuses(db: D1Database): Promise<SourceStatus[]> {
  return Promise.all(
    ENABLED_SOURCES.map(async (source) => {
      const last = await db
        .prepare("SELECT mode, started_at, finished_at, items_fetched, error FROM source_runs WHERE source = ? ORDER BY started_at DESC LIMIT 1")
        .bind(source)
        .first<SourceRun>();
      // Only completed, comparable runs: an unfinished run has no item count yet.
      const latest = await db
        .prepare(
          `SELECT started_at, items_fetched FROM source_runs
           WHERE source = ? AND mode != 'backfill' AND finished_at IS NOT NULL AND items_fetched IS NOT NULL AND error IS NULL
           ORDER BY started_at DESC LIMIT 1`,
        )
        .bind(source)
        .first<{ started_at: string; items_fetched: number }>();
      const avg = latest
        ? await db
            .prepare(
              `SELECT avg(items_fetched) AS a FROM source_runs
               WHERE source = ? AND mode != 'backfill' AND error IS NULL AND finished_at IS NOT NULL AND items_fetched IS NOT NULL
                 AND started_at < ? AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-7 days')`,
            )
            .bind(source, latest.started_at, latest.started_at)
            .first<{ a: number | null }>()
        : null;
      const weekAverage = avg?.a ?? null;
      const dropWarning = Boolean(latest && weekAverage && latest.items_fetched < weekAverage / 2);
      return { source, last, weekAverage, dropWarning };
    }),
  );
}

export async function postCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare("SELECT status, count(*) AS n FROM posts GROUP BY status").all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, r.n]));
}

function sourcesFor(choice: string): Source[] {
  if (choice === "all") return [...ENABLED_SOURCES];
  if ((ENABLED_SOURCES as readonly string[]).includes(choice)) return [choice as Source];
  throw new Error(`Unknown source: ${choice}`);
}

/** "Run now": one manual fetch job per chosen source. */
export async function runNow(fetchQueue: Queue, choice: string): Promise<FetchJob[]> {
  const jobs = fetchJobs(sourcesFor(choice), "manual");
  await sendAll(fetchQueue, jobs);
  return jobs;
}

/** The latest run of the daily trending update (engagement, GitHub stats, scores). */
export async function trendingStatus(db: D1Database): Promise<SourceRun | null> {
  return db
    .prepare("SELECT mode, started_at, finished_at, items_fetched, error FROM source_runs WHERE source = 'trending' ORDER BY started_at DESC LIMIT 1")
    .first<SourceRun>();
}

/** "Run now" for the trending update. */
export async function runTrending(fetchQueue: Queue): Promise<void> {
  const job: TrendingJob = { kind: "trending", mode: "manual" };
  await fetchQueue.send(job);
}

export const MAX_BACKFILL_DAYS = 180;

/** Enqueues a backfill and records it in `operations` so the status panel can show its progress. */
export async function startBackfill(db: D1Database, fetchQueue: Queue, choice: string, days: number, now = Date.now()): Promise<FetchJob[]> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) throw new Error(`Days must be a whole number from 1 to ${MAX_BACKFILL_DAYS}.`);
  const sources = sourcesFor(choice);
  const jobs = fetchJobs(sources, "backfill", { days, now });
  await sendAll(fetchQueue, jobs);
  await db
    .prepare("INSERT INTO operations (kind, source, days, total, started_at) VALUES ('backfill', ?, ?, ?, ?)")
    .bind(choice, days, backfillRunCount(sources, days), iso(now))
    .run();
  return jobs;
}

export interface ReclassifyPreview {
  /** Unreviewed queued posts that will be re-run. */
  posts: number;
  /** Queued posts with a review decision, left alone. */
  kept: number;
  /** Posts dropped by an older model, re-run only if chosen. */
  oldDrops: number;
}

export async function reclassifyPreview(db: D1Database): Promise<ReclassifyPreview> {
  const r = await db.prepare(RESET_PREVIEW_SQL).first<{ posts: number; kept: number; old_drops: number }>();
  return { posts: r?.posts ?? 0, kept: r?.kept ?? 0, oldDrops: r?.old_drops ?? 0 };
}

/** Resets unreviewed queued posts (and, if chosen, old-model drops) and enqueues every pending post for classification. */
export async function reclassifyQueued(db: D1Database, classifyQueue: Queue, now = Date.now(), options: { includeOldDrops?: boolean } = {}): Promise<number> {
  const ids = await resetUnreviewedQueued(db, options);
  // Forced: re-run the model even when a same-URL post already has a result.
  await sendAll<ClassifyJob>(classifyQueue, ids.map((post_id) => ({ kind: "classify", post_id, force: true })));
  if (ids.length > 0) {
    await db
      .prepare("INSERT INTO operations (kind, total, last_post_id, started_at) VALUES ('reclassify', ?, ?, ?)")
      .bind(ids.length, Math.max(...ids), iso(now))
      .run();
  }
  return ids.length;
}

/** Classification rate is measured over at most this window. */
const RATE_WINDOW_MIN = 15;
/** Fewer classified posts than this in the window is too little to estimate a finish time from. */
const RATE_MIN_SAMPLES = 3;
/** A backfill's fetching is over once no fetch run has started for this long (failed days are not retried forever). */
const FETCH_QUIET_MIN = 60;

export interface ClassifyProgress {
  pending: number;
  /**
   * Posts classified per minute, over the last 15 minutes or since classifying
   * started within them, so a run that just began isn't averaged with idle time.
   */
  perMinute: number;
  /** Minutes until nothing is pending at the current rate, or null when nothing is moving or it's too early to tell. */
  etaMinutes: number | null;
  /** Posts are waiting but none was classified in 15 minutes (usually the daily AI spend cap). */
  stalled: boolean;
}

export async function classifyProgress(db: D1Database, now = Date.now()): Promise<ClassifyProgress> {
  const since = iso(now - RATE_WINDOW_MIN * MINUTE);
  const r = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM posts WHERE status = 'pending') AS pending,
         (SELECT count(*) FROM posts WHERE classified_at >= ?1 AND status != 'pending') AS recent,
         (SELECT min(classified_at) FROM posts WHERE classified_at >= ?1 AND status != 'pending') AS first,
         (SELECT min(created_at) FROM posts WHERE status = 'pending') AS oldest`,
    )
    .bind(since)
    .first<{ pending: number; recent: number; first: string | null; oldest: string | null }>();
  const pending = r?.pending ?? 0;
  const recent = r?.recent ?? 0;
  // Measure from the first classification in the window (at least a minute), not
  // the whole window: after an idle spell the 15 minutes would mostly be idle time.
  const elapsed = r?.first ? (now - Date.parse(r.first)) / MINUTE : RATE_WINDOW_MIN;
  const perMinute = recent / Math.min(RATE_WINDOW_MIN, Math.max(1, elapsed));
  return {
    pending,
    perMinute,
    etaMinutes: pending > 0 && recent >= RATE_MIN_SAMPLES ? Math.ceil(pending / perMinute) : null,
    stalled: pending > 0 && perMinute === 0 && r?.oldest != null && r.oldest < since,
  };
}

export interface Operation {
  id: number;
  kind: "backfill" | "reclassify";
  source: string | null;
  days: number | null;
  started_at: string;
  finished_at: string | null;
  /** Backfill only: fetch runs that succeeded, failed attempts (retried automatically), and runs expected. */
  fetch: { done: number; failed: number; total: number; settled: boolean } | null;
  /** Posts classified out of the posts this operation is waiting on. */
  classify: { done: number; total: number };
}

interface OperationRow {
  id: number;
  kind: "backfill" | "reclassify";
  source: string | null;
  days: number | null;
  total: number;
  last_post_id: number | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * Operations still running, plus those finished in the last day. Progress is derived
 * from posts and source_runs; an operation is marked finished the first time this
 * sees it complete. Overlapping backfills share the same runs and posts, so their
 * numbers are approximate.
 */
export async function operations(db: D1Database, now = Date.now()): Promise<Operation[]> {
  const { results } = await db
    .prepare(// Unfinished first, so a run of finished ones never hides an active one.
      "SELECT * FROM operations WHERE finished_at IS NULL OR finished_at >= ? ORDER BY finished_at IS NULL DESC, id DESC LIMIT 5")
    .bind(iso(now - 1440 * MINUTE))
    .all<OperationRow>();
  return Promise.all(results.map((op) => (op.kind === "backfill" ? backfillProgress(db, op, now) : reclassifyProgress(db, op, now))));
}

async function reclassifyProgress(db: D1Database, op: OperationRow, now: number): Promise<Operation> {
  const r = await db
    .prepare("SELECT count(*) AS n FROM posts WHERE status = 'pending' AND id <= ?")
    .bind(op.last_post_id ?? 0)
    .first<{ n: number }>();
  const done = Math.max(0, op.total - (r?.n ?? 0));
  const finished_at = op.finished_at ?? (done >= op.total ? await finish(db, op.id, now) : null);
  // Once finished it stays complete, even if a later re-classify resets the same posts.
  return { ...pick(op), finished_at, fetch: null, classify: { done: finished_at ? op.total : done, total: op.total } };
}

async function backfillProgress(db: D1Database, op: OperationRow, now: number): Promise<Operation> {
  const sourceFilter = op.source && op.source !== "all" ? op.source : null;
  // A finished backfill only counts what happened while it ran.
  const until = op.finished_at;
  const runs = await db
    .prepare(
      `SELECT
         count(CASE WHEN finished_at IS NOT NULL AND error IS NULL THEN 1 END) AS done,
         count(CASE WHEN error IS NOT NULL THEN 1 END) AS failed,
         max(started_at) AS last_started
       FROM source_runs
       WHERE mode = 'backfill' AND started_at >= ?1 AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR started_at < ?3)`,
    )
    .bind(op.started_at, sourceFilter, until)
    .first<{ done: number; failed: number; last_started: string | null }>();
  const posts = await db
    .prepare(
      `SELECT count(*) AS total, count(CASE WHEN status != 'pending' THEN 1 END) AS done
       FROM posts WHERE created_at >= ?1 AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR created_at < ?3)`,
    )
    .bind(op.started_at, sourceFilter, until)
    .first<{ total: number; done: number }>();
  const done = Math.min(runs?.done ?? 0, op.total);
  const quietSince = iso(now - FETCH_QUIET_MIN * MINUTE);
  const settled = done >= op.total || (runs?.last_started ?? op.started_at) < quietSince;
  const classify = { done: posts?.done ?? 0, total: posts?.total ?? 0 };
  const complete = settled && classify.done >= classify.total;
  const finished_at = op.finished_at ?? (complete ? await finish(db, op.id, now) : null);
  // Stays complete even if a later re-classify sends some of its posts back to pending.
  if (finished_at) classify.done = classify.total;
  return { ...pick(op), finished_at, fetch: { done, failed: runs?.failed ?? 0, total: op.total, settled: settled || !!finished_at }, classify };
}

const pick = (op: OperationRow) => ({ id: op.id, kind: op.kind, source: op.source, days: op.days, started_at: op.started_at });

async function finish(db: D1Database, id: number, now: number): Promise<string> {
  const at = iso(now);
  await db.prepare("UPDATE operations SET finished_at = ? WHERE id = ? AND finished_at IS NULL").bind(at, id).run();
  return at;
}

// Rough planning numbers shown before a backfill, from October 2026 measurements:
// posts passing the pre-filter per day by source, and GLM 5.3 Flash cost per post.
const POSTS_PER_DAY: Record<string, number> = { hn: 284, lobsters: 7, github: 25 };
const COST_PER_POST_USD = 0.0004;
/** Planning rate for estimates (two at a time, 4-10s a call); the In progress section shows the measured rate. */
export const CLASSIFY_PER_MINUTE = 12;

export function backfillEstimate(choice: string, days: number): { posts: number; costUsd: number; hours: number } {
  const posts = sourcesFor(choice).reduce((n, s) => n + (POSTS_PER_DAY[s] ?? 0) * days, 0);
  return { posts, costUsd: posts * COST_PER_POST_USD, hours: posts / CLASSIFY_PER_MINUTE / 60 };
}
