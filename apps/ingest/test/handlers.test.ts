import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { requeueStalePending } from "../src/classify-job.ts";
import { depsFromEnv } from "../src/deps.ts";
import worker from "../src/index.ts";
import { fakeQueue, resetDb } from "./helpers.ts";

beforeEach(resetDb);

it("enqueues one daily fetch job per source, a languages job, and re-queues stale pending posts", async () => {
  const insert = (id: string, createdAt: string) =>
    env.DB.prepare(
      "INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, created_at) VALUES ('hn', ?, 'https://x.dev', 'https://x.dev', 't', ?, ?) RETURNING id",
    )
      .bind(id, createdAt, createdAt)
      .first<{ id: number }>();
  const stale = await insert("stale", "2026-01-01T00:00:00.000Z");
  await insert("fresh", new Date().toISOString());

  const fetchQ = fakeQueue();
  const classifyQ = fakeQueue();
  const ctx = createExecutionContext();
  const scheduledTime = Date.parse("2026-10-06T06:00:00Z");
  await worker.scheduled(
    createScheduledController({ cron: "0 6 * * *", scheduledTime }),
    { ...env, FETCH_QUEUE: fetchQ.queue, CLASSIFY_QUEUE: classifyQ.queue },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(fetchQ.sent).toEqual([
    { kind: "fetch", source: "hn", mode: "daily", until: "2026-10-06T06:00:00.000Z" },
    { kind: "fetch", source: "lobsters", mode: "daily", until: "2026-10-06T06:00:00.000Z" },
    { kind: "fetch", source: "github", mode: "daily", until: "2026-10-06T06:00:00.000Z" },
    { kind: "languages" },
  ]);
  expect(classifyQ.sent).toEqual([{ kind: "classify", post_id: stale!.id }]);
});

it("the 07:00 cron enqueues the daily trending update only", async () => {
  const fetchQ = fakeQueue();
  const classifyQ = fakeQueue();
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ cron: "0 7 * * *", scheduledTime: Date.parse("2026-10-06T07:00:00Z") }),
    { ...env, FETCH_QUEUE: fetchQ.queue, CLASSIFY_QUEUE: classifyQ.queue },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(fetchQ.sent).toEqual([{ kind: "trending", mode: "daily" }]);
  expect(classifyQ.sent).toEqual([]);
});

it("runs trending jobs from the fetch queue", async () => {
  const batch = createMessageBatch("sb-fetch", [{ id: "t", timestamp: new Date(), attempts: 1, body: { kind: "trending", mode: "manual" } }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks).toEqual(["t"]);
  const run = await env.DB.prepare("SELECT source, mode FROM source_runs").first();
  expect(run).toEqual({ source: "trending", mode: "manual" });
});

it("runs languages jobs from the fetch queue", async () => {
  await env.DB.prepare(
    "INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status) VALUES ('hn', 'l', 'https://x.dev', 'https://x.dev', 'Show HN: an agent for the terminal', '2026-10-01T00:00:00.000Z', 'queued')",
  ).run();
  const batch = createMessageBatch("sb-fetch", [{ id: "l", timestamp: new Date(), attempts: 1, body: { kind: "languages" } }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks).toEqual(["l"]);
  expect(await env.DB.prepare("SELECT language FROM posts").first()).toEqual({ language: "en" });
});

it("sends every Workers AI call through the AI Gateway", async () => {
  const calls: unknown[][] = [];
  const ai = { run: async (...args: unknown[]) => (calls.push(args), { response: "{}" }) } as unknown as Ai;
  await depsFromEnv({ ...env, AI: ai }).ai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [] });
  expect(calls[0]![2]).toEqual({ gateway: { id: "sb", skipCache: true } });
});

it("acks malformed messages and jobs with nothing to do", async () => {
  const batch = createMessageBatch("sb-fetch", [
    { id: "bad", timestamp: new Date(), attempts: 1, body: { kind: "fetch", source: "digg" } },
    { id: "noop", timestamp: new Date(), attempts: 1, body: { kind: "fetch", source: "producthunt", mode: "manual" } },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks).toEqual(["bad", "noop"]);
});

it("retries a message whose job throws", async () => {
  const batch = createMessageBatch("sb-classify", [
    { id: "boom", timestamp: new Date(), attempts: 2, body: { kind: "classify", post_id: 1 } },
  ]);
  const brokenDb = {
    prepare() {
      throw new Error("D1 unavailable");
    },
  } as unknown as D1Database;
  const ctx = createExecutionContext();
  await worker.queue(batch, { ...env, DB: brokenDb }, ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.retryMessages.map((m: { msgId: string }) => m.msgId)).toEqual(["boom"]);
});

it("ENABLED_SOURCES in core matches the ingest adapters", async () => {
  const { ENABLED_SOURCES } = await import("@slop-bucket/core");
  const { ADAPTERS } = await import("../src/sources/index.ts");
  expect([...ENABLED_SOURCES].sort()).toEqual(Object.keys(ADAPTERS).sort());
});

it("WINDOWED_SOURCES in core matches the adapters that fan out", async () => {
  const { WINDOWED_SOURCES } = await import("@slop-bucket/core");
  const { ADAPTERS } = await import("../src/sources/index.ts");
  const windowed = Object.entries(ADAPTERS).filter(([, a]) => a.windowed).map(([s]) => s);
  expect([...WINDOWED_SOURCES].sort()).toEqual(windowed.sort());
});

it("re-queues stale pending posts in batches of 100, up to the limit", async () => {
  const rows = Array.from({ length: 250 }, (_, i) =>
    env.DB.prepare(
      "INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, created_at) VALUES ('hn', ?, 'https://x.dev', 'https://x.dev', 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).bind(`p${i}`),
  );
  await env.DB.batch(rows);
  const q = fakeQueue();
  expect(await requeueStalePending(env.DB, q.queue, 220)).toBe(220);
  expect(q.sent).toHaveLength(220);
  expect(new Set(q.sent.map((j) => (j as { post_id: number }).post_id)).size).toBe(220);
});
