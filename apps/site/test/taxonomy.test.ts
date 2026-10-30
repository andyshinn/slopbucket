import { env } from "cloudflare:workers";
import { getSetting } from "@slop-bucket/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaxonomyError,
  addCategory,
  canMove,
  categoryOverview,
  loadCategorySettings,
  mergeCategory,
  otherShare,
  reorderCategory,
  saveCategorySettings,
  updateCategory,
} from "../src/lib/taxonomy-admin.ts";

const db = env.DB;
let original: { categories: string; info: string };
beforeEach(async () => {
  await db.batch(["review_decisions", "posts", "tool_aliases", "tool_merges", "reports", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const row = (key: string) => db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  original = { categories: (await row("categories"))!.value, info: (await row("category_info"))!.value };
});
afterEach(async () => {
  const save = "UPDATE settings SET value = ? WHERE key = ?";
  await db.batch([db.prepare(save).bind(original.categories, "categories"), db.prepare(save).bind(original.info, "category_info")]);
});

let nextId = 0;
async function tool(category: string, status = "queued") {
  const id = ++nextId;
  await db.prepare("INSERT INTO tools (id, slug, name, status, category, first_seen_at) VALUES (?, ?, ?, ?, ?, '2026-10-01T00:00:00Z')").bind(id, `t-${id}`, `T ${id}`, status, category).run();
  return id;
}
async function post(category: string, status = "queued") {
  const row = await db
    .prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, classification) VALUES ('hn', ?, 'u', 'u', 't', '2026-10-01T00:00:00Z', ?, ?) RETURNING id")
    .bind(`p${++nextId}`, status, JSON.stringify({ category, confidence: 0.9 }))
    .first<{ id: number }>();
  return row!.id;
}
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const fields = (over: Record<string, string> = {}) => form({ slug: "spec-tools", label: "Spec tools", hue: "green", hint: "spec-driven development tools", blurb: "Specs first.", ...over });
const categoryOf = async (table: "tools" | "posts", id: number) =>
  table === "tools"
    ? (await db.prepare("SELECT category FROM tools WHERE id = ?").bind(id).first<{ category: string }>())!.category
    : (await db.prepare("SELECT json_extract(classification, '$.category') AS c FROM posts WHERE id = ?").bind(id).first<{ c: string }>())!.c;

describe("categoryOverview", () => {
  it("counts visible tools and queued posts per category, and lists categories no longer in the list", async () => {
    await tool("agent");
    await tool("agent", "published");
    await tool("agent", "hidden");
    await tool("retired");
    await post("agent");
    await post("agent", "published");
    await post("retired");
    const o = await categoryOverview(db);
    expect(o.rows.find((r) => r.slug === "agent")).toMatchObject({ label: "Agent", hue: "violet", tools: 2, queued: 1 });
    expect(o.rows.at(-1)?.slug).toBe("other");
    expect(o.orphans).toEqual([{ slug: "retired", tools: 1, queued: 1 }]);
    expect(o.totalTools).toBe(3);
  });

  it("warns when other holds more than a fifth of tools", async () => {
    await tool("agent");
    await tool("agent");
    await tool("other");
    expect(otherShare(await categoryOverview(db))).toBeCloseTo(1 / 3);
    await tool("agent");
    await tool("agent");
    expect(otherShare(await categoryOverview(db))).toBeNull();
  });
});

describe("addCategory", () => {
  it("adds a category above other with its details", async () => {
    expect(await addCategory(db, fields({ slug: " Spec Tools " }))).toBe("spec-tools");
    const categories = await getSetting(db, "categories");
    expect(categories.slice(-2)).toEqual(["spec-tools", "other"]);
    expect((await getSetting(db, "category_info"))["spec-tools"]).toEqual({ label: "Spec tools", hue: "green", hint: "spec-driven development tools", blurb: "Specs first." });
  });

  it("refuses a duplicate slug, a blank label and an unknown color", async () => {
    await expect(addCategory(db, fields({ slug: "agent" }))).rejects.toThrow("already a category");
    await expect(addCategory(db, fields({ label: " " }))).rejects.toThrow(TaxonomyError);
    await expect(addCategory(db, fields({ hue: "lime" }))).rejects.toThrow("color");
    expect(await db.prepare("SELECT value FROM settings WHERE key = 'categories'").first<{ value: string }>()).toEqual({ value: original.categories });
  });
});

describe("updateCategory", () => {
  it("saves details in place", async () => {
    expect(await updateCategory(db, "cli", fields({ slug: "cli", label: "Command line", hue: "amber" }))).toBe("cli");
    expect((await getSetting(db, "category_info")).cli).toMatchObject({ label: "Command line", hint: "spec-driven development tools" });
    expect(await getSetting(db, "categories")).toEqual(JSON.parse(original.categories));
  });

  it("renames in place, moving tools, posts and review corrections", async () => {
    const t = await tool("cli");
    const p = await post("cli");
    await db.prepare("INSERT INTO review_decisions (post_id, decision, corrected_fields, decided_at) VALUES (?, 'edit', ?, '2026-10-02T00:00:00Z')").bind(p, '{"category":"cli"}').run();
    expect(await updateCategory(db, "cli", fields({ slug: "terminal", label: "Terminal", hue: "amber" }))).toBe("terminal");
    const categories = await getSetting(db, "categories");
    const before = JSON.parse(original.categories) as string[];
    expect(categories.indexOf("terminal")).toBe(before.indexOf("cli"));
    expect(categories).not.toContain("cli");
    const info = await getSetting(db, "category_info");
    expect(info.cli).toBeUndefined();
    expect(info.terminal?.label).toBe("Terminal");
    expect(await categoryOf("tools", t)).toBe("terminal");
    expect(await categoryOf("posts", p)).toBe("terminal");
    const d = await db.prepare("SELECT json_extract(corrected_fields, '$.category') AS c FROM review_decisions WHERE post_id = ?").bind(p).first<{ c: string }>();
    expect(d!.c).toBe("terminal");
  });

  it("refuses renaming other or onto an existing category", async () => {
    await expect(updateCategory(db, "other", fields({ slug: "misc" }))).rejects.toThrow("can't be renamed");
    await expect(updateCategory(db, "cli", fields({ slug: "agent" }))).rejects.toThrow("Merge");
    await expect(updateCategory(db, "nope", fields())).rejects.toThrow("not a category");
  });
});

describe("canMove", () => {
  it("keeps other last and the ends in place, wherever other is stored", () => {
    expect(canMove(["a", "b", "other"], "a", "up")).toBe(false);
    expect(canMove(["a", "b", "other"], "a", "down")).toBe(true);
    expect(canMove(["a", "b", "other"], "b", "down")).toBe(false);
    expect(canMove(["a", "other", "b"], "b", "up")).toBe(false);
    expect(canMove(["a", "other", "b"], "other", "down")).toBe(false);
    expect(canMove(["a", "b", "other"], "nope", "up")).toBe(false);
  });
});

describe("saveCategorySettings", () => {
  it("changes nothing and throws when a setting changed after it was read", async () => {
    const t = await tool("cli");
    const read = await loadCategorySettings(db);
    // Another tab reorders in the meantime.
    await reorderCategory(db, "cli", "up");
    const after = await loadCategorySettings(db);
    await expect(
      saveCategorySettings(db, read, read.categories.filter((c) => c !== "cli"), read.info, { from: "cli", into: "other" }),
    ).rejects.toThrow("changed somewhere else");
    expect((await loadCategorySettings(db)).stored).toEqual(after.stored);
    expect(await categoryOf("tools", t)).toBe("cli");
  });
});

describe("reorderCategory", () => {
  it("swaps neighbours and keeps other last", async () => {
    const before = JSON.parse(original.categories) as string[];
    await reorderCategory(db, before[1]!, "up");
    expect((await getSetting(db, "categories")).slice(0, 2)).toEqual([before[1], before[0]]);
    const lastBeforeOther = before.at(-2)!;
    await reorderCategory(db, lastBeforeOther, "down");
    await reorderCategory(db, "other", "up");
    expect((await getSetting(db, "categories")).slice(-2)).toEqual([lastBeforeOther, "other"]);
  });
});

describe("mergeCategory", () => {
  it("moves everything into the target and removes the category", async () => {
    const t = await tool("mcp-general");
    const p = await post("mcp-general");
    await mergeCategory(db, "mcp-general", "mcp-dev");
    expect(await getSetting(db, "categories")).not.toContain("mcp-general");
    expect((await getSetting(db, "category_info"))["mcp-general"]).toBeUndefined();
    expect(await categoryOf("tools", t)).toBe("mcp-dev");
    expect(await categoryOf("posts", p)).toBe("mcp-dev");
  });

  it("moves an orphan's tools and posts without touching the list", async () => {
    const t = await tool("retired");
    await mergeCategory(db, "retired", "other");
    expect(await categoryOf("tools", t)).toBe("other");
    expect(await getSetting(db, "categories")).toEqual(JSON.parse(original.categories));
  });

  it("refuses removing other, or merging into itself or an unknown category", async () => {
    await expect(mergeCategory(db, "other", "agent")).rejects.toThrow("can't be removed");
    await expect(mergeCategory(db, "cli", "cli")).rejects.toThrow("different");
    await expect(mergeCategory(db, "cli", "nope")).rejects.toThrow("Pick a category");
  });
});
