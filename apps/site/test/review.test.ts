import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ReviewError,
  approvePost,
  editPost,
  getQueueItem,
  isNewTool,
  nextQueuedId,
  parseEditForm,
  queueCount,
  reassignPost,
  rejectPost,
  searchTools,
  tagChips,
} from "../src/lib/review.ts";

const db = env.DB;

beforeEach(async () => {
  await db.batch(["review_decisions", "post_snapshots", "tool_aliases", "posts", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

const classification = (over: Record<string, unknown> = {}) => ({
  is_ai_dev_tool: true, post_type: "launch", tool_name: "Patchwork", homepage_url: "https://patchwork.dev/",
  github_repo: "acme/patchwork", version: null, category: "agent", tags: ["claude-code"], is_open_source: true,
  description: "Reviews pull requests.", confidence: 0.9, ...over,
});

async function tool(name: string, over: Record<string, unknown> = {}): Promise<number> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const row = await db
    .prepare("INSERT INTO tools (slug, name, description, category, status) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(slug, name, over.description ?? `${name} does things`, over.category ?? "agent", over.status ?? "queued")
    .first<{ id: number }>();
  await db.prepare("INSERT INTO tool_aliases (tool_id, kind, value) VALUES (?, 'name', ?)").bind(row!.id, slug.replace(/-/g, "")).run();
  return row!.id;
}

let n = 0;
async function post(toolId: number | null, c: Record<string, unknown> | null = classification(), status = "queued"): Promise<number> {
  n++;
  const row = await db
    .prepare(
      `INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, tool_id, classification, confidence)
       VALUES ('hn', ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', ?, ?, ?, ?) RETURNING id`,
    )
    .bind(String(n), `https://e.com/${n}`, `https://e.com/${n}`, `Post ${n}`, status, toolId, c ? JSON.stringify(c) : null, (c?.confidence as number) ?? null)
    .first<{ id: number }>();
  return row!.id;
}

const status = (table: string, id: number) => db.prepare(`SELECT status FROM ${table} WHERE id = ?`).bind(id).first<{ status: string }>().then((r) => r?.status);
const decisions = () => db.prepare("SELECT post_id, decision, corrected_fields, use_in_prompt FROM review_decisions ORDER BY id").all().then((r) => r.results);

describe("queue navigation", () => {
  it("counts queued posts and walks them oldest first, wrapping around", async () => {
    const t = await tool("Patchwork");
    const a = await post(t);
    const b = await post(t);
    await post(t, classification(), "published");
    expect(await queueCount(db)).toBe(2);
    expect(await nextQueuedId(db)).toBe(a);
    expect(await nextQueuedId(db, a)).toBe(b);
    expect(await nextQueuedId(db, b)).toBe(a);
  });

  it("returns null for an empty queue", async () => {
    expect(await nextQueuedId(db)).toBeNull();
  });

  it("loads a post with its tool summary", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    const item = await getQueueItem(db, id);
    expect(item?.tool).toMatchObject({ id: t, name: "Patchwork", posts: 1 });
    expect(item?.classification?.tool_name).toBe("Patchwork");
  });
});

describe("approve and reject", () => {
  it("approve publishes the post and its queued tool and records the decision", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    await approvePost(db, id, true);
    expect(await status("posts", id)).toBe("published");
    expect(await status("tools", t)).toBe("published");
    expect(await decisions()).toEqual([{ post_id: id, decision: "approve", corrected_fields: null, use_in_prompt: 1 }]);
  });

  it("approve leaves a hidden tool hidden", async () => {
    const t = await tool("Patchwork", { status: "hidden" });
    await approvePost(db, await post(t), false);
    expect(await status("tools", t)).toBe("hidden");
  });

  it("approve refuses a post without a tool or classification", async () => {
    const id = await post(null, null);
    await expect(approvePost(db, id, false)).rejects.toThrow(ReviewError);
  });

  it("reject marks the post rejected and records 'not an AI coding tool' for few-shot use", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    await rejectPost(db, id, true);
    expect(await status("posts", id)).toBe("rejected");
    expect(await status("tools", t)).toBe("queued");
    expect(await decisions()).toEqual([{ post_id: id, decision: "reject", corrected_fields: '{"is_ai_dev_tool":false}', use_in_prompt: 1 }]);
  });

  it("lets exactly one of two simultaneous submissions win (double tap, two tabs)", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    const results = await Promise.allSettled([approvePost(db, id, false), rejectPost(db, id, true), approvePost(db, id, false)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ReviewError);
    }
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(await status("posts", id)).toBe(rows[0]!.decision === "approve" ? "published" : "rejected");
  });

  it("refuses to act twice on the same post", async () => {
    const id = await post(await tool("Patchwork"));
    await approvePost(db, id, false);
    await expect(rejectPost(db, id, false)).rejects.toThrow("already published");
  });
});

describe("reassign", () => {
  it("moves the post to another tool and keeps it queued", async () => {
    const a = await tool("Patchwork");
    const b = await tool("Lintbot");
    const id = await post(a);
    await reassignPost(db, id, b);
    expect((await getQueueItem(db, id))?.post).toMatchObject({ tool_id: b, status: "queued" });
    expect(await decisions()).toMatchObject([{ decision: "reassign", corrected_fields: `{"tool_id":${b}}`, use_in_prompt: 0 }]);
  });

  it("refuses an unknown tool", async () => {
    await expect(reassignPost(db, await post(await tool("Patchwork")), 999_999)).rejects.toThrow("Tool not found");
  });
});

describe("editPost", () => {
  const form = (over: Record<string, string> = {}) => {
    const f = new FormData();
    const base: Record<string, string> = {
      is_ai_dev_tool: "true", post_type: "launch", tool_name: "Patchwork", homepage_url: "https://patchwork.dev/",
      github_repo: "acme/patchwork", version: "", category: "agent", tags: "claude-code", is_open_source: "true",
      description: "Reviews pull requests.",
    };
    for (const [k, v] of Object.entries({ ...base, ...over })) {
      if (k === "tags") for (const t of v.split(",").map((x) => x.trim()).filter(Boolean)) f.append(k, t); // one checkbox each
      else f.set(k, v);
    }
    return parseEditForm(f);
  };

  it("records only the changed fields and updates them on the same tool", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    expect(await editPost(db, id, form({ category: "cli", tags: "claude-code, cli" }), true)).toBe("approved");
    expect(await decisions()).toEqual([
      { post_id: id, decision: "edit", corrected_fields: '{"category":"cli","tags":["claude-code","cli"]}', use_in_prompt: 1 },
    ]);
    const row = await db.prepare("SELECT category, tags, status FROM tools WHERE id = ?").bind(t).first();
    expect(row).toEqual({ category: "cli", tags: '["claude-code","cli"]', status: "published" });
    expect(await status("posts", id)).toBe("published");
  });

  it("re-resolves the tool when the name changes", async () => {
    const wrong = await tool("Patchwork");
    const right = await tool("Lintbot");
    const id = await post(wrong);
    await editPost(db, id, form({ tool_name: "Lintbot", github_repo: "", homepage_url: "" }), false);
    expect((await getQueueItem(db, id))?.post.tool_id).toBe(right);
  });

  it("creates a tool for a post the model could not classify", async () => {
    const id = await post(null, null);
    await editPost(db, id, form({ tool_name: "Brand New", github_repo: "new/brand-new" }), false);
    const item = await getQueueItem(db, id);
    expect(item?.tool).toMatchObject({ name: "Brand New", status: "published" });
  });

  it("rejects when the reviewer marks it out of scope", async () => {
    const id = await post(await tool("Patchwork"));
    expect(await editPost(db, id, form({ is_ai_dev_tool: "false" }), true)).toBe("rejected");
    expect(await status("posts", id)).toBe("rejected");
    expect(await decisions()).toMatchObject([{ decision: "edit", corrected_fields: '{"is_ai_dev_tool":false}' }]);
  });

  it("validates input like model output: unknown category fails, unsafe homepage is dropped", async () => {
    const t = await tool("Patchwork");
    await expect(editPost(db, await post(t), form({ category: "sdk" }), false)).rejects.toThrow("category");
    const id = await post(t);
    await editPost(db, id, form({ homepage_url: "javascript:alert(1)" }), false);
    const row = await db.prepare("SELECT homepage_url FROM tools WHERE id = ?").bind(t).first();
    expect(row).toEqual({ homepage_url: null });
  });

  it("keeps the tool's name when the name is cleared but a repo is given", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    await editPost(db, id, form({ tool_name: "", category: "cli" }), false);
    const row = await db.prepare("SELECT t.name FROM posts p JOIN tools t ON t.id = p.tool_id WHERE p.id = ?").bind(id).first();
    expect(row).toEqual({ name: "Patchwork" });
  });

  it("only keeps tags from the vocabulary", async () => {
    const t = await tool("Patchwork");
    const id = await post(t);
    await editPost(db, id, form({ tags: "claude-code, not-a-tag, macos" }), false);
    const row = await db.prepare("SELECT tags FROM tools WHERE id = ?").bind(t).first();
    expect(row).toEqual({ tags: '["claude-code","macos"]' });
  });

  it("requires a tool name or repo", async () => {
    const id = await post(null, null);
    await expect(editPost(db, id, form({ tool_name: "", github_repo: "" }), false)).rejects.toThrow("name or a GitHub repo");
  });
});

describe("searchTools", () => {
  it("matches word prefixes across name and description", async () => {
    const a = await tool("Patchwork", { description: "AI code review agent" });
    await tool("Lintbot", { description: "Lints things" });
    expect((await searchTools(db, "patch")).map((t) => t.id)).toEqual([a]);
    expect((await searchTools(db, "review ag")).map((t) => t.id)).toEqual([a]);
    expect(await searchTools(db, '"; DROP TABLE tools; --')).toEqual([]);
  });
});

describe("queue item display", () => {
  const groups = [
    { slug: "works-with", label: "Works with", hint: "", tags: [{ slug: "claude-code", label: "Claude Code" }] },
    { slug: "platform", label: "Platform", hint: "", tags: [{ slug: "macos", label: "macOS" }] },
  ];

  it("labels vocabulary tags and marks the rest unknown", () => {
    expect(tagChips(["macos", "rust", "claude-code", "macos", ""], groups)).toEqual([
      { slug: "macos", label: "macOS", known: true },
      { slug: "rust", label: "rust", known: false },
      { slug: "claude-code", label: "Claude Code", known: true },
    ]);
    expect(tagChips(undefined, groups)).toEqual([]);
    expect(tagChips("macos", groups)).toEqual([]);
  });

  it("calls a tool new when this is the only post of a queued tool", async () => {
    const id = await tool("Patchwork");
    const first = await post(id);
    expect(isNewTool((await getQueueItem(db, first))!.tool!)).toBe(true);
    await post(id);
    expect(isNewTool((await getQueueItem(db, first))!.tool!)).toBe(false);
    const published = await tool("Shipped", { status: "published" });
    expect(isNewTool((await getQueueItem(db, await post(published)))!.tool!)).toBe(false);
  });
});
