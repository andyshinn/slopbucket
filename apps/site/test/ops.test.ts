import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_DAILY_CAP_USD,
  backfillEstimate,
  classifyProgress,
  etaMinutesFor,
  operations,
  postCounts,
  reclassifyPreview,
  reclassifyQueued,
  runNow,
  runTrending,
  sourceStatuses,
  startBackfill,
  trendingStatus,
} from "../src/lib/ops.ts";

const db = env.DB;
function fakeQueue() {
  const sent: unknown[] = [];
  const queue = { sendBatch: async (msgs: Iterable<{ body: unknown }>) => void [...msgs].forEach((m) => sent.push(m.body)) } as unknown as Queue;
  return { queue, sent };
}

beforeEach(async () => {
  await db.batch(["review_decisions", "tool_aliases", "posts", "tools", "source_runs", "operations"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

describe("run now and backfill", () => {
  it("enqueues one manual job per enabled source, or one for a single source", async () => {
    const q = fakeQueue();
    await runNow(q.queue, "all");
    expect(q.sent).toEqual([
      { kind: "fetch", source: "hn", mode: "manual" },
      { kind: "fetch", source: "lobsters", mode: "manual" },
      { kind: "fetch", source: "github", mode: "manual" },
    ]);
    const one = fakeQueue();
    await runNow(one.queue, "github");
    expect(one.sent).toHaveLength(1);
    await expect(runNow(one.queue, "producthunt")).rejects.toThrow("Unknown source");
  });

  it("enqueues backfill jobs covering the last N days", async () => {
    const q = fakeQueue();
    const now = Date.parse("2026-10-07T00:00:00Z");
    await startBackfill(db, q.queue, "hn", 7, now);
    expect(q.sent).toEqual([{ kind: "fetch", source: "hn", mode: "backfill", since: "2026-09-30T00:00:00.000Z", until: "2026-10-07T00:00:00.000Z" }]);
    await expect(startBackfill(db, q.queue, "hn", 0)).rejects.toThrow("Days must be");
    await expect(startBackfill(db, q.queue, "hn", 9999)).rejects.toThrow("Days must be");
    expect(await db.prepare("SELECT kind, source, days, total FROM operations").all().then((r) => r.results)).toEqual([
      { kind: "backfill", source: "hn", days: 7, total: 7 },
    ]);
  });

  it("estimates backfill size and cost", () => {
    const e = backfillEstimate("all", 90);
    expect(e.posts).toBeGreaterThan(20_000);
    expect(e.costUsd).toBeGreaterThan(5);
    expect(AI_DAILY_CAP_USD).toBeGreaterThan(0);
    expect(e.capDays).toBe(Math.ceil(e.costUsd / (AI_DAILY_CAP_USD ?? 1)));
    expect(backfillEstimate("lobsters", 10).capDays).toBe(1);
    expect(backfillEstimate("lobsters", 10).posts).toBe(70);
  });
});

describe("reclassify", () => {
  it("resets unreviewed queued posts, keeps reviewed ones and enqueues the pending posts", async () => {
    await db.batch([
      db.prepare("INSERT INTO tools (id, slug, name, status) VALUES (1, 'junk', 'Junk', 'queued'), (2, 'pub', 'Pub', 'published')"),
      db.prepare("INSERT INTO tool_aliases (tool_id, kind, value) VALUES (1, 'name', 'junk')"),
      db.prepare(
        `INSERT INTO posts (id, source, external_id, url, canonical_url, title, posted_at, status, tool_id, classification) VALUES
         (10, 'hn', '10', 'u', 'u', 'a', '2026-10-01T00:00:00Z', 'queued', 1, '{}'),
         (11, 'hn', '11', 'u', 'u', 'b', '2026-10-01T00:00:00Z', 'queued', 2, '{}'),
         (12, 'hn', '12', 'u', 'u', 'c', '2026-10-01T00:00:00Z', 'queued', 2, '{}'),
         (13, 'hn', '13', 'u', 'u', 'd', '2026-10-01T00:00:00Z', 'dropped', NULL, '{}')`,
      ),
      db.prepare("INSERT INTO review_decisions (post_id, decision) VALUES (12, 'reassign')"),
    ]);
    expect(await reclassifyPreview(db)).toEqual({ posts: 2, kept: 1, oldDrops: 1 });

    const q = fakeQueue();
    expect(await reclassifyQueued(db, q.queue)).toBe(2);
    expect(q.sent).toEqual([{ kind: "classify", post_id: 10, force: true }, { kind: "classify", post_id: 11, force: true }]);
    expect(await postCounts(db)).toEqual({ pending: 2, queued: 1, dropped: 1 });
    const tools = await db.prepare("SELECT id FROM tools ORDER BY id").all<{ id: number }>();
    expect(tools.results.map((t) => t.id)).toEqual([2]); // the junk tool and its alias are gone
    expect(await db.prepare("SELECT count(*) AS n FROM tool_aliases").first()).toEqual({ n: 0 });
  });
});

describe("reclassify with old-model drops", () => {
  it("re-checks posts dropped by an older model only when asked, and keeps current-model drops", async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO posts (id, source, external_id, url, canonical_url, title, posted_at, status, classification, drop_reason) VALUES
         (20, 'hn', '20', 'u', 'u', 'legacy', '2026-10-01T00:00:00Z', 'dropped', '{"is_ai_dev_tool":false}', 'not_ai_dev_tool'),
         (21, 'hn', '21', 'u', 'u', 'older model', '2026-10-01T00:00:00Z', 'dropped', '{"model":"@cf/meta/llama"}', 'not_ai_dev_tool'),
         (22, 'hn', '22', 'u', 'u', 'current model', '2026-10-01T00:00:00Z', 'dropped', '{"model":"@cf/zai-org/glm-5.3-flash"}', 'not_ai_dev_tool')`,
      ),
    ]);
    expect((await reclassifyPreview(db)).oldDrops).toBe(2);

    expect(await reclassifyQueued(db, fakeQueue().queue)).toBe(0);
    expect(await postCounts(db)).toEqual({ dropped: 3 });

    const q = fakeQueue();
    expect(await reclassifyQueued(db, q.queue, Date.now(), { includeOldDrops: true })).toBe(2);
    expect(q.sent).toEqual([{ kind: "classify", post_id: 20, force: true }, { kind: "classify", post_id: 21, force: true }]);
    const reset = await db.prepare("SELECT classification, drop_reason FROM posts WHERE id = 20").first();
    expect(reset).toEqual({ classification: null, drop_reason: null });
    expect(await postCounts(db)).toEqual({ pending: 2, dropped: 1 });
  });
});

describe("sourceStatuses", () => {
  const run = (source: string, startedAt: string, items: number | null, error: string | null = null, mode = "daily", finished = true) =>
    db
      .prepare("INSERT INTO source_runs (source, mode, started_at, finished_at, items_fetched, error) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(source, mode, startedAt, finished ? startedAt : null, items, error);

  it("reports the last run, the 7-day average and a drop warning", async () => {
    await db.batch([
      run("hn", "2026-10-03T06:00:00.000Z", 1000),
      run("hn", "2026-10-04T06:00:00.000Z", 1100),
      run("hn", "2026-10-05T06:00:00.000Z", 50),
      run("lobsters", "2026-10-05T06:00:00.000Z", 30),
      run("github", "2026-10-05T06:00:00.000Z", 0, "GitHub search -> 403"),
    ]);
    const s = Object.fromEntries((await sourceStatuses(db)).map((x) => [x.source, x]));
    expect(s.hn).toMatchObject({ weekAverage: 1050, dropWarning: true });
    expect(s.hn!.last!.items_fetched).toBe(50);
    expect(s.lobsters).toMatchObject({ weekAverage: null, dropWarning: false });
    expect(s.github!.last!.error).toContain("403");
    expect(s.github!.dropWarning).toBe(false); // an error is shown instead
  });

  it("leaves backfill runs out of the comparison", async () => {
    await db.batch([
      run("lobsters", "2026-10-03T06:00:00.000Z", 30),
      run("lobsters", "2026-10-04T12:00:00.000Z", 2400, null, "backfill"),
      run("lobsters", "2026-10-05T06:00:00.000Z", 28),
    ]);
    const lobsters = (await sourceStatuses(db)).find((x) => x.source === "lobsters")!;
    expect(lobsters).toMatchObject({ weekAverage: 30, dropWarning: false });
  });

  it("shows a run in progress without treating it as a drop", async () => {
    await db.batch([
      run("hn", "2026-10-04T06:00:00.000Z", 1100),
      run("hn", "2026-10-05T06:00:00.000Z", 1000),
      run("hn", "2026-10-06T06:00:00.000Z", null, null, "daily", false),
    ]);
    const hn = (await sourceStatuses(db)).find((x) => x.source === "hn")!;
    expect(hn.last).toMatchObject({ finished_at: null, items_fetched: null });
    expect(hn).toMatchObject({ weekAverage: 1100, dropWarning: false });
  });
});

describe("progress", () => {
  const T0 = Date.parse("2026-10-07T12:00:00Z");
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  let next = 100;
  const post = (status: string, createdAt: string, classifiedAt: string | null = null, source = "hn") =>
    db
      .prepare(
        "INSERT INTO posts (id, source, external_id, url, canonical_url, title, posted_at, status, created_at, classified_at) VALUES (?, ?, ?, 'u', 'u', 't', ?, ?, ?, ?)",
      )
      .bind(++next, source, String(next), createdAt, status, createdAt, classifiedAt);
  const backfillRun = (source: string, startedAt: string, error: string | null = null) =>
    db
      .prepare("INSERT INTO source_runs (source, mode, started_at, finished_at, items_fetched, error) VALUES (?, 'backfill', ?, ?, 10, ?)")
      .bind(source, startedAt, startedAt, error);

  it("stamps classified_at when a post leaves pending", async () => {
    await db.batch([post("pending", at(-60))]);
    await db.prepare("UPDATE posts SET status = 'queued' WHERE id = ?").bind(next).run();
    const row = await db.prepare("SELECT classified_at FROM posts WHERE id = ?").bind(next).first<{ classified_at: string | null }>();
    expect(row!.classified_at).not.toBeNull();
  });

  it("reports the classification rate, an ETA and a stall", async () => {
    await db.batch([
      // Two a minute, steadily, across the whole 15-minute window.
      ...Array.from({ length: 30 }, (_, i) => post("queued", at(-60), at(-15 + i / 2))),
      ...Array.from({ length: 60 }, () => post("pending", at(-60))),
    ]);
    expect(await classifyProgress(db, T0)).toEqual({ pending: 60, perMinute: 2, reliable: true, etaMinutes: 30, stalled: false });
    // An hour later nothing has moved: stalled, no ETA.
    expect(await classifyProgress(db, T0 + 60 * 60_000)).toMatchObject({ pending: 60, perMinute: 0, etaMinutes: null, stalled: true });
  });

  it("measures a run that just started from its first classification, not the idle window", async () => {
    await db.batch([
      // Classifying began two minutes ago after a long idle spell: six done since.
      ...Array.from({ length: 6 }, (_, i) => post("queued", at(-60), at(-2 + i / 3))),
      ...Array.from({ length: 300 }, () => post("pending", at(-60))),
    ]);
    expect(await classifyProgress(db, T0)).toMatchObject({ pending: 300, perMinute: 3, etaMinutes: 100 });
  });

  it("gives no ETA from fewer than three classifications", async () => {
    await db.batch([post("queued", at(-60), at(-0.5)), post("queued", at(-60), at(-0.25)), post("pending", at(-60))]);
    expect(await classifyProgress(db, T0)).toMatchObject({ pending: 1, perMinute: 2, reliable: false, etaMinutes: null, stalled: false });
  });

  it("gives an ETA from exactly three, and floors the measuring time at a minute", async () => {
    // Three done in the last few seconds: 3 a minute, not hundreds.
    await db.batch([...[-0.1, -0.05, -0.01].map((m) => post("queued", at(-60), at(m))), ...Array.from({ length: 30 }, () => post("pending", at(-60)))]);
    expect(await classifyProgress(db, T0)).toMatchObject({ pending: 30, perMinute: 3, reliable: true, etaMinutes: 10 });
  });

  it("estimates any remaining count with the same rule", () => {
    expect(etaMinutesFor(30, { perMinute: 3, reliable: true })).toBe(10);
    expect(etaMinutesFor(30, { perMinute: 3, reliable: false })).toBeNull();
    expect(etaMinutesFor(0, { perMinute: 3, reliable: true })).toBeNull();
    expect(etaMinutesFor(30, { perMinute: 0, reliable: true })).toBeNull();
  });

  it("does not count a re-classified post as throughput", async () => {
    await db.batch([post("queued", at(-60), at(-5))]);
    await reclassifyQueued(db, fakeQueue().queue, T0);
    const row = await db.prepare("SELECT status, classified_at FROM posts WHERE id = ?").bind(next).first();
    expect(row).toEqual({ status: "pending", classified_at: null });
    expect(await classifyProgress(db, T0)).toMatchObject({ pending: 1, perMinute: 0 });
  });

  it("does not call fresh pending posts stalled", async () => {
    await db.batch([post("pending", at(-1))]);
    expect((await classifyProgress(db, T0)).stalled).toBe(false);
  });

  it("tracks a re-classify until its posts are classified", async () => {
    await db.batch([post("queued", at(-600)), post("queued", at(-600))]);
    const q = fakeQueue();
    await reclassifyQueued(db, q.queue, T0);
    await db.batch([post("pending", at(1))]); // a newer post is not part of it

    let [op] = await operations(db, T0 + 60_000);
    expect(op).toMatchObject({ kind: "reclassify", finished_at: null, fetch: null, classify: { done: 0, total: 2 } });

    await db.prepare("UPDATE posts SET status = 'dropped' WHERE id <= ?").bind(next - 1).run();
    [op] = await operations(db, T0 + 120_000);
    expect(op).toMatchObject({ classify: { done: 2, total: 2 }, finished_at: at(2) });
    // A later re-classify of the same posts does not make it look unfinished.
    await db.prepare("UPDATE posts SET status = 'pending' WHERE id <= ?").bind(next - 1).run();
    [op] = await operations(db, T0 + 180_000);
    expect(op).toMatchObject({ classify: { done: 2, total: 2 }, finished_at: at(2) });
    // Finished operations drop off after a day.
    expect(await operations(db, T0 + 2 * 1440 * 60_000)).toEqual([]);
  });

  it("lists unfinished operations ahead of finished ones", async () => {
    await db.prepare("INSERT INTO operations (kind, total, last_post_id, started_at) VALUES ('reclassify', 1, 0, ?)").bind(at(-30)).run();
    await db.batch(
      Array.from({ length: 6 }, (_, i) =>
        db.prepare("INSERT INTO operations (kind, total, last_post_id, started_at, finished_at) VALUES ('reclassify', 1, 0, ?, ?)").bind(at(-20 + i), at(-10)),
      ),
    );
    await db.batch([post("pending", at(-60))]);
    await db.prepare("UPDATE operations SET last_post_id = ? WHERE finished_at IS NULL").bind(next).run();
    const ops = await operations(db, T0);
    expect(ops).toHaveLength(5);
    expect(ops[0]).toMatchObject({ finished_at: null, started_at: at(-30) });
  });

  it("tracks a backfill's fetch runs and the posts they stored", async () => {
    const q = fakeQueue();
    await startBackfill(db, q.queue, "all", 3, T0); // hn 3 + github 3 + lobsters 1
    await db.batch([
      backfillRun("hn", at(1)),
      backfillRun("hn", at(2), "Algolia -> 500"),
      backfillRun("github", at(3)),
      backfillRun("hn", at(-5)), // before the backfill
      post("pending", at(2)),
      post("dropped", at(2), at(4)),
      post("queued", at(-30), at(-20)), // before the backfill
    ]);

    let [op] = await operations(db, T0 + 10 * 60_000);
    expect(op).toMatchObject({
      kind: "backfill", source: "all", days: 3, finished_at: null,
      fetch: { done: 2, failed: 1, total: 7, settled: false }, classify: { done: 1, total: 2 },
    });

    // An hour with no new fetch runs: fetching is over even though days failed; done once posts are classified.
    await db.prepare("UPDATE posts SET status = 'queued' WHERE status = 'pending'").run();
    [op] = await operations(db, T0 + 90 * 60_000);
    expect(op!.fetch).toMatchObject({ done: 2, settled: true });
    expect(op!.finished_at).not.toBeNull();

    // Posts and runs after it finished are not counted.
    await db.batch([post("pending", at(200)), backfillRun("hn", at(200))]);
    [op] = await operations(db, T0 + 210 * 60_000);
    expect(op).toMatchObject({ fetch: { done: 2 }, classify: { done: 2, total: 2 } });
  });
});

describe("trending", () => {
  it("enqueues a manual trending update and reports the latest run", async () => {
    const sent: unknown[] = [];
    await runTrending({ send: async (body: unknown) => void sent.push(body) } as unknown as Queue);
    expect(sent).toEqual([{ kind: "trending", mode: "manual" }]);

    expect(await trendingStatus(db)).toBeNull();
    await db
      .prepare(
        "INSERT INTO source_runs (source, mode, started_at, finished_at, items_fetched, error) VALUES ('trending', 'daily', ?, ?, 42, NULL), ('hn', 'daily', ?, ?, 9, NULL)",
      )
      .bind("2026-10-08T07:00:00.000Z", "2026-10-08T07:01:00.000Z", "2026-10-08T08:00:00.000Z", "2026-10-08T08:01:00.000Z")
      .run();
    expect(await trendingStatus(db)).toMatchObject({ mode: "daily", items_fetched: 42, error: null });
  });
});
