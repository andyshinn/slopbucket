import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { REPORT_REASONS, ReportError, submitReport, verifyTurnstile } from "../src/lib/reports.ts";
import { engagement, lookupTool, threadUrl } from "../src/lib/tool-page.ts";

const db = env.DB;
beforeEach(async () => {
  await db.batch(["reports", "post_snapshots", "repo_snapshots", "tool_aliases", "posts", "tool_merges", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

async function tool(slug: string, status = "published") {
  const row = await db.prepare("INSERT INTO tools (slug, name, category, status) VALUES (?, ?, 'cli', ?) RETURNING id").bind(slug, slug.toUpperCase(), status).first<{ id: number }>();
  return row!.id;
}
let n = 0;
async function post(toolId: number, o: { status?: string; type?: string; postedAt: string; score?: number }) {
  const row = await db
    .prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, tool_id, post_type) VALUES ('hn', ?, 'https://x.dev', 'https://x.dev', 'A post', ?, ?, ?, ?) RETURNING id")
    .bind(String(++n), o.postedAt, o.status ?? "published", toolId, o.type ?? "launch")
    .first<{ id: number }>();
  if (o.score !== undefined) {
    await db.batch([
      db.prepare("INSERT INTO post_snapshots (post_id, date, score, comments) VALUES (?, '2026-10-01', 1, 1)").bind(row!.id),
      db.prepare("INSERT INTO post_snapshots (post_id, date, score, comments) VALUES (?, '2026-10-02', ?, 7)").bind(row!.id, o.score),
    ]);
  }
  return row!.id;
}
const merge = (from: number, into: number, undone = false) =>
  db.prepare("INSERT INTO tool_merges (from_tool_id, into_tool_id, undone_at) VALUES (?, ?, ?)").bind(from, into, undone ? "2026-10-05" : null).run();

describe("lookupTool", () => {
  it("returns a published tool with its published posts, newest first, and latest engagement", async () => {
    const id = await tool("pi");
    await post(id, { postedAt: "2026-10-01T00:00:00Z", score: 686 });
    await post(id, { postedAt: "2026-10-05T00:00:00Z", type: "release" });
    await post(id, { postedAt: "2026-10-09T00:00:00Z", status: "queued" });
    const found = await lookupTool(db, "pi");
    expect(found && "tool" in found && found.tool.name).toBe("PI");
    const posts = found && "posts" in found ? found.posts : [];
    expect(posts.map((p) => p.post_type)).toEqual(["release", "launch"]);
    expect(posts[1]).toMatchObject({ score: 686, comments: 7 });
    expect(found && "firstPost" in found && found.firstPost).toEqual({ source: "hn", posted_at: "2026-10-01T00:00:00Z" });
  });

  it("redirects a merged tool to its target, following chains, and 404s the rest", async () => {
    const a = await tool("a", "hidden");
    const b = await tool("b", "hidden");
    const c = await tool("c");
    await merge(a, b);
    await merge(b, c);
    expect(await lookupTool(db, "a")).toEqual({ redirect: "/tools/c" });
    expect(await lookupTool(db, "b")).toEqual({ redirect: "/tools/c" });

    const d = await tool("d", "hidden");
    await merge(d, c, true);
    expect(await lookupTool(db, "d")).toBeNull();
    await tool("q", "queued");
    expect(await lookupTool(db, "q")).toBeNull();
    expect(await lookupTool(db, "nope")).toBeNull();
  });
});

describe("timeline helpers", () => {
  it("links HN and lobste.rs threads only for valid ids", () => {
    expect(threadUrl({ source: "hn", external_id: "123" })?.href).toBe("https://news.ycombinator.com/item?id=123");
    expect(threadUrl({ source: "lobsters", external_id: "abc12" })?.href).toBe("https://lobste.rs/s/abc12");
    expect(threadUrl({ source: "hn", external_id: "javascript:x" })).toBeNull();
    expect(threadUrl({ source: "github", external_id: "a/b" })).toBeNull();
  });

  it("describes engagement per source", () => {
    const c = (n: number) => String(n);
    expect(engagement({ source: "hn", score: 686, comments: 362 }, c)).toBe("686 points · 362 comments");
    expect(engagement({ source: "hn", score: 1, comments: 1 }, c)).toBe("1 point · 1 comment");
    expect(engagement({ source: "github", score: 1200, comments: 0 }, c)).toBe("1200 stars");
    expect(engagement({ source: "hn", score: null, comments: null }, c)).toBe("");
  });
});

describe("reports", () => {
  const post = (o: Record<string, string>, ip = "203.0.113.9") => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return new Request("https://slopbucket.app/tools/pi/report", { method: "POST", body: f, headers: { "cf-connecting-ip": ip } });
  };
  const ok = (async () => Response.json({ success: true })) as typeof fetch;
  const fail = (async () => Response.json({ success: false })) as typeof fetch;
  const valid = { reason: "spam", note: " Buy now ", "cf-turnstile-response": "token" };

  it("stores a valid report", async () => {
    const id = await tool("pi");
    await submitReport(db, id, post(valid), { turnstileSecret: "s", fetcher: ok });
    expect(await db.prepare("SELECT reason, note, resolved_at FROM reports").first()).toEqual({ reason: "spam", note: "Buy now", resolved_at: null });
  });

  it("refuses when off, malformed, invalid, failing the bot check or rate limited", async () => {
    const id = await tool("pi");
    const status = async (req: Request, deps: Parameters<typeof submitReport>[3]) => {
      try {
        await submitReport(db, id, req, deps);
        return 200;
      } catch (err) {
        return err instanceof ReportError ? err.status : 500;
      }
    };
    const on = { turnstileSecret: "s", fetcher: ok };
    expect(await status(post(valid), { fetcher: ok })).toBe(503);
    expect(await status(new Request("https://x.dev", { method: "POST", body: "{", headers: { "content-type": "application/json" } }), on)).toBe(400);
    expect(await status(post({ reason: "nope", "cf-turnstile-response": "t" }), on)).toBe(422);
    expect(await status(post({ reason: "spam", note: "x".repeat(501) }), on)).toBe(422);
    expect(await status(post(valid), { turnstileSecret: "s", fetcher: fail })).toBe(400);
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as RateLimit;
    expect(await status(post(valid), { ...on, limiter })).toBe(429);
    expect(keys).toEqual(["report:203.0.113.9"]);
    // A failed bot check doesn't count toward the limit.
    await status(post(valid), { turnstileSecret: "s", fetcher: fail, limiter });
    expect(keys).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) AS n FROM reports").first("n")).toBe(0);
    expect(Object.keys(REPORT_REASONS)).toEqual(["not-ai-tool", "wrong-merge", "spam", "broken-link"]);
  });

  it("sends the secret, token and IP to siteverify", async () => {
    let body: unknown;
    const spy = (async (_url: string, init: RequestInit) => ((body = JSON.parse(String(init.body))), Response.json({ success: true }))) as unknown as typeof fetch;
    expect(await verifyTurnstile("sec", "tok", "203.0.113.9", spy)).toBe(true);
    expect(body).toEqual({ secret: "sec", response: "tok", remoteip: "203.0.113.9" });
    expect(await verifyTurnstile("sec", "", null, spy)).toBe(false);
  });
});
