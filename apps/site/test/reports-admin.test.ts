import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { navCounts } from "../src/lib/admin-nav.ts";
import { listReports, reasonLabel, resolveReport } from "../src/lib/reports-admin.ts";

const db = env.DB;
beforeEach(async () => {
  await db.batch(["reports", "tool_aliases", "posts", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

async function report(toolId: number, reason: string, createdAt: string, resolvedAt: string | null = null) {
  const row = await db
    .prepare("INSERT INTO reports (tool_id, reason, note, created_at, resolved_at) VALUES (?, ?, 'a note', ?, ?) RETURNING id")
    .bind(toolId, reason, createdAt, resolvedAt)
    .first<{ id: number }>();
  return row!.id;
}

describe("navCounts", () => {
  it("counts queued posts, visible tools and open reports", async () => {
    await db.batch([
      db.prepare("INSERT INTO tools (id, slug, name, status) VALUES (1, 'a', 'A', 'published'), (2, 'b', 'B', 'queued'), (3, 'c', 'C', 'hidden')"),
      db.prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, tool_id) VALUES ('hn', '1', 'u', 'u', 't', '2026-10-01', 'queued', 2), ('hn', '2', 'u', 'u', 't', '2026-10-01', 'published', 1)"),
      db.prepare("INSERT INTO reports (tool_id, reason) VALUES (1, 'spam')"),
    ]);
    expect(await navCounts(db)).toEqual({ queue: 1, tools: 2, reports: 1 });
  });
});

describe("reports admin", () => {
  it("lists open reports newest first with their tool, resolves once, then lists them as resolved", async () => {
    const tool = (await db.prepare("INSERT INTO tools (slug, name, status) VALUES ('pi', 'Pi', 'published') RETURNING id").first<{ id: number }>())!.id;
    const older = await report(tool, "spam", "2026-10-01T00:00:00Z");
    const newer = await report(tool, "wrong-merge", "2026-10-02T00:00:00Z");
    await report(tool, "broken-link", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");

    expect((await listReports(db)).map((r) => r.id)).toEqual([newer, older]);
    expect((await listReports(db))[0]).toMatchObject({ tool_name: "Pi", tool_slug: "pi", tool_status: "published", note: "a note" });
    expect((await navCounts(db))?.reports).toBe(2);

    expect(await resolveReport(db, older)).toBe(true);
    expect(await resolveReport(db, older)).toBe(false);
    expect(await resolveReport(db, 9999)).toBe(false);
    expect((await navCounts(db))?.reports).toBe(1);
    const resolved = await listReports(db, true);
    expect(resolved.map((r) => r.id)[0]).toBe(older);
    expect(resolved).toHaveLength(2);
  });

  it("labels reasons, falling back to the stored value", () => {
    expect(reasonLabel("wrong-merge")).toBe("Wrong merge");
    expect(reasonLabel("toString")).toBe("toString");
  });
});
