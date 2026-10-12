import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ToolError,
  addAlias,
  getTool,
  listTools,
  mergeHistory,
  mergePreview,
  mergeTools,
  mergedInto,
  removeAlias,
  setHidden,
  splitMerge,
  toolStatusCounts,
  updateTool,
} from "../src/lib/tools-admin.ts";

const db = env.DB;
beforeEach(async () => {
  await db.batch(["review_decisions", "post_snapshots", "repo_snapshots", "tool_aliases", "posts", "tool_merges", "reports", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

let nextId = 0;
async function tool(name: string, over: { repo?: string; status?: string; category?: string; score?: number; firstSeen?: string } = {}) {
  const id = ++nextId;
  await db.batch([
    db
      .prepare("INSERT INTO tools (id, slug, name, github_repo, status, category, trending_score, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, `${name.toLowerCase().replace(/\W+/g, "-")}-${id}`, name, over.repo ?? null, over.status ?? "queued", over.category ?? "agent", over.score ?? 0, over.firstSeen ?? "2026-10-01T00:00:00.000Z"),
    db.prepare("INSERT INTO tool_aliases (tool_id, kind, value) VALUES (?, 'name', ?)").bind(id, name.toLowerCase().replace(/\W+/g, "")),
    ...(over.repo ? [db.prepare("INSERT INTO tool_aliases (tool_id, kind, value) VALUES (?, 'repo', ?)").bind(id, over.repo)] : []),
  ]);
  return id;
}
async function post(toolId: number, status = "queued", postedAt = "2026-10-05T00:00:00.000Z") {
  const row = await db
    .prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, tool_id) VALUES ('hn', ?, 'https://x.dev', 'https://x.dev', 'A post', ?, ?, ?) RETURNING id")
    .bind(`p${++nextId}`, postedAt, status, toolId)
    .first<{ id: number }>();
  return row!.id;
}
const form = (entries: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of [v].flat()) f.append(k, x);
  return f;
};
const valid = (over: Record<string, string | string[]> = {}) =>
  form({
    name: "Worktrunk", slug: "worktrunk", description: "Git worktrees for agents.", category: "agent-tools",
    tags: ["claude-code", "not-a-tag"], homepage_url: "worktrunk.dev", github_repo: "https://github.com/Max/Worktrunk", is_open_source: "true", ...over,
  });

describe("listTools", () => {
  it("searches names and aliases, filters by status and category, and sorts", async () => {
    const a = await tool("Worktrunk", { repo: "max/worktrunk", status: "published", score: 2 });
    const b = await tool("Hall Monitor", { category: "agent-tools", score: 5 });
    await tool("Hidden Thing", { status: "hidden", firstSeen: "2026-10-07T00:00:00.000Z" });
    await post(a);
    await post(a);

    const byRepo = await listTools(db, { q: "max/work" });
    expect(byRepo.tools.map((t) => t.id)).toEqual([a]);
    expect(byRepo.tools[0]).toMatchObject({ posts: 2, github_repo: "max/worktrunk", status: "published" });
    // "Hall-Monitor" normalizes to the stored name alias "hallmonitor".
    expect((await listTools(db, { q: "Hall-Monitor" })).tools.map((t) => t.id)).toEqual([b]);
    expect((await listTools(db, { status: "hidden" })).total).toBe(1);
    expect((await listTools(db, { category: "agent-tools" })).tools.map((t) => t.id)).toEqual([b]);
    expect((await listTools(db, {})).tools.map((t) => t.name)).toEqual(["Hall Monitor", "Worktrunk", "Hidden Thing"]);
    expect((await listTools(db, { sort: "newest" })).tools[0]!.name).toBe("Hidden Thing");
    expect((await listTools(db, { sort: "bogus", status: "bogus" })).total).toBe(3);
    expect(await toolStatusCounts(db)).toEqual({ published: 1, queued: 1, hidden: 1 });
  });

  it("pages through results", async () => {
    for (let i = 0; i < 55; i++) await tool(`Tool ${i}`);
    const p2 = await listTools(db, { page: 2 });
    expect(p2.total).toBe(55);
    expect(p2.tools).toHaveLength(5);
  });
});

describe("updateTool", () => {
  it("saves validated fields, keeps only vocabulary tags and adds aliases", async () => {
    const id = await tool("Work Trunk");
    await updateTool(db, id, valid());
    const t = await getTool(db, id);
    expect(t).toMatchObject({
      name: "Worktrunk", slug: "worktrunk", description: "Git worktrees for agents.", category: "agent-tools", tags: ["claude-code"],
      homepage_url: "https://worktrunk.dev/", github_repo: "max/worktrunk", is_open_source: 1,
    });
    expect(t!.aliases.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "repo", value: "max/worktrunk" },
      { kind: "domain", value: "worktrunk.dev" },
      { kind: "name", value: "worktrunk" },
    ]);
  });

  it("limits posts unless asked for more", async () => {
    const id = await tool("Busy");
    for (let i = 0; i < 3; i++) await post(id);
    expect(await getTool(db, id, 2)).toMatchObject({ postCount: 3, posts: [{}, {}] });
    expect((await getTool(db, id, 500))!.posts).toHaveLength(3);
  });

  it("refuses a taken slug, another tool's repo, a bad category and a long description", async () => {
    const id = await tool("Worktrunk");
    await tool("Other", { repo: "max/worktrunk" });
    await db.prepare("UPDATE tools SET slug = 'taken' WHERE id != ?").bind(id).run();
    await expect(updateTool(db, id, valid({ slug: "taken" }))).rejects.toThrow('"taken" is already used');
    await expect(updateTool(db, id, valid())).rejects.toThrow("max/worktrunk already belongs to Other. Merge");
    await expect(updateTool(db, id, valid({ github_repo: "", category: "sdk" }))).rejects.toThrow("category");
    await expect(updateTool(db, id, valid({ github_repo: "", description: "x".repeat(141) }))).rejects.toThrow("keep it to 140");
    // Newlines and runs of spaces collapse before the length check, matching what the one-line input sends.
    await updateTool(db, id, valid({ github_repo: "", description: `Git\n  worktrees${" ".repeat(150)}for agents.` }));
    expect((await getTool(db, id))!.description).toBe("Git worktrees for agents.");
    await expect(updateTool(db, id, valid({ github_repo: "", slug: "Bad Slug" }))).rejects.toThrow(ToolError);
  });
});

describe("aliases", () => {
  it("normalizes, refuses shared hosts and other tools' aliases, and removes", async () => {
    const id = await tool("Worktrunk");
    const other = await tool("Other", { repo: "acme/other" });
    await addAlias(db, id, "repo", "https://github.com/Max/WT");
    await addAlias(db, id, "domain", "https://www.worktrunk.dev/docs");
    await addAlias(db, id, "name", "Work Trunk CLI");
    await expect(addAlias(db, id, "domain", "max.github.io")).rejects.toThrow("shared host");
    await expect(addAlias(db, id, "repo", "acme/other")).rejects.toThrow("already belongs to Other");
    expect((await getTool(db, id))!.aliases).toEqual([
      { kind: "repo", value: "max/wt", via_merge: false },
      { kind: "domain", value: "worktrunk.dev", via_merge: false },
      { kind: "name", value: "worktrunk", via_merge: false },
    ]);
    await removeAlias(db, id, "repo", "max/wt");
    await removeAlias(db, id, "repo", "acme/other"); // not this tool's: no effect
    expect((await getTool(db, id))!.aliases).toHaveLength(2);
    expect((await getTool(db, other))!.aliases).toHaveLength(2);
  });
});

describe("hide", () => {
  it("hides, and unhides to published only if a post is published", async () => {
    const a = await tool("A", { status: "published" });
    await post(a, "published");
    const b = await tool("B");
    await post(b, "queued");
    for (const id of [a, b]) await setHidden(db, id, true);
    expect(await toolStatusCounts(db)).toEqual({ hidden: 2 });
    for (const id of [a, b]) await setHidden(db, id, false);
    expect((await getTool(db, a))!.status).toBe("published");
    expect((await getTool(db, b))!.status).toBe("queued");
  });
});

describe("merge and split", () => {
  it("moves posts and aliases, fills blanks, hides the merged tool, and splits back", async () => {
    const keep = await tool("Worktrunk", { repo: "max/worktrunk", status: "queued" });
    const dupe = await tool("Worktrunk CLI", { status: "published" });
    await db.prepare("UPDATE tools SET homepage_url = 'https://wt.dev/', tags = '[\"cli\"]', first_seen_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").bind(dupe).run();
    await db.prepare("UPDATE tools SET tags = '[\"claude-code\"]' WHERE id = ?").bind(keep).run();
    const kept = await post(keep, "queued", "2026-10-01T00:00:00.000Z");
    const moved = await post(dupe, "published", "2026-10-06T00:00:00.000Z");

    const preview = await mergePreview(db, dupe, keep);
    expect(preview.posts.map((p) => p.id)).toEqual([moved]);
    expect(preview.aliases).toEqual([{ kind: "name", value: "worktrunkcli" }]);

    await mergeTools(db, dupe, keep);
    const k = await getTool(db, keep);
    expect(k).toMatchObject({
      status: "published", // it now has a published post
      homepage_url: "https://wt.dev/",
      github_repo: "max/worktrunk",
      first_seen_at: "2026-09-01T00:00:00.000Z",
      last_post_at: "2026-10-06T00:00:00.000Z",
      postCount: 2,
    });
    expect([...k!.tags].sort()).toEqual(["claude-code", "cli"]);
    expect(k!.aliases.map((a) => a.value).sort()).toEqual(["max/worktrunk", "worktrunk", "worktrunkcli"]);
    // Only the moved alias is marked; the target's own aliases (here before and after the merge) are not.
    expect(k!.aliases.filter((a) => a.via_merge).map((a) => a.value)).toEqual(["worktrunkcli"]);
    // Removed and re-added by hand, it still counts as via merge while the merge is active (DESIGN.md).
    await removeAlias(db, keep, "name", "worktrunkcli");
    await addAlias(db, keep, "name", "worktrunkcli");
    expect((await getTool(db, keep))!.aliases.find((a) => a.value === "worktrunkcli")!.via_merge).toBe(true);
    expect((await getTool(db, dupe))!.status).toBe("hidden");
    expect(await mergedInto(db, dupe)).toMatchObject({ id: keep, name: "Worktrunk" });
    const listed = await listTools(db, { status: "hidden" });
    expect(listed.tools[0]).toMatchObject({ id: dupe, merged_into: "Worktrunk" });
    await expect(setHidden(db, dupe, false)).rejects.toThrow("Split the merge");
    await expect(mergeTools(db, dupe, keep)).rejects.toThrow("already merged");

    const [history] = await mergeHistory(db, keep);
    expect(history).toMatchObject({ from_tool_id: dupe, from_name: "Worktrunk CLI", posts: 1, aliases: 1 });
    expect(await splitMerge(db, history!.id)).toEqual({ fromId: dupe, posts: 1 });
    const d = await getTool(db, dupe);
    expect(d).toMatchObject({ status: "published", postCount: 1, last_post_at: "2026-10-06T00:00:00.000Z" });
    expect(d!.aliases).toEqual([{ kind: "name", value: "worktrunkcli", via_merge: false }]);
    expect(await getTool(db, keep)).toMatchObject({ postCount: 1, last_post_at: "2026-10-01T00:00:00.000Z" });
    expect(kept).toBeGreaterThan(0);
    expect(await mergeHistory(db, keep)).toEqual([]);
    await expect(splitMerge(db, history!.id)).rejects.toThrow("already split");
  });

  it("leaves posts that moved on after the merge where they are", async () => {
    const a = await tool("A");
    const b = await tool("B");
    const c = await tool("C");
    const p = await post(a);
    await mergeTools(db, a, b);
    await db.prepare("UPDATE posts SET tool_id = ? WHERE id = ?").bind(c, p).run(); // reassigned later
    const [m] = await mergeHistory(db, b);
    expect((await splitMerge(db, m!.id)).posts).toBe(0);
    expect((await getTool(db, c))!.postCount).toBe(1);
  });

  it("refuses merging a tool into itself or into a merged-away tool", async () => {
    const a = await tool("A");
    const b = await tool("B");
    const c = await tool("C");
    await expect(mergePreview(db, a, a)).rejects.toThrow("different tool");
    await mergeTools(db, b, c);
    await expect(mergeTools(db, a, b)).rejects.toThrow("merge into that one instead");
  });
});
