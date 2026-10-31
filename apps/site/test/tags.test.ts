import { env } from "cloudflare:workers";
import { getSetting } from "@slop-bucket/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canMoveIn } from "../src/lib/taxonomy-admin.ts";
import {
  addGroup,
  addTag,
  deleteTag,
  loadTagSettings,
  mapTag,
  mergeTag,
  reorderGroup,
  reorderTag,
  saveTagSettings,
  suggestedTags,
  tagOverview,
  updateGroup,
  updateTag,
} from "../src/lib/tags-admin.ts";

const db = env.DB;
let original: string;
beforeEach(async () => {
  await db.batch(["review_decisions", "posts", "tool_aliases", "tool_merges", "reports", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  original = (await db.prepare("SELECT value FROM settings WHERE key = 'tags'").first<{ value: string }>())!.value;
});
afterEach(async () => {
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'tags'").bind(original).run();
});

let nextId = 0;
async function tool(tags: string[], status = "queued") {
  const id = ++nextId;
  await db
    .prepare("INSERT INTO tools (id, slug, name, status, category, tags, first_seen_at) VALUES (?, ?, ?, ?, 'cli', ?, '2026-10-01T00:00:00Z')")
    .bind(id, `t-${id}`, `T ${id}`, status, JSON.stringify(tags))
    .run();
  return id;
}
async function post(classification: Record<string, unknown>, opts: { status?: string; toolId?: number } = {}) {
  const row = await db
    .prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, classification, tool_id) VALUES ('hn', ?, 'u', 'u', 't', '2026-10-01T00:00:00Z', ?, ?, ?) RETURNING id")
    .bind(`p${++nextId}`, opts.status ?? "queued", JSON.stringify({ category: "cli", confidence: 0.9, ...classification }), opts.toolId ?? null)
    .first<{ id: number }>();
  return row!.id;
}
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const toolTags = async (id: number) => JSON.parse((await db.prepare("SELECT tags FROM tools WHERE id = ?").bind(id).first<{ tags: string }>())!.tags) as string[];
const classification = async (id: number) =>
  JSON.parse((await db.prepare("SELECT classification FROM posts WHERE id = ?").bind(id).first<{ classification: string }>())!.classification) as { tags?: string[]; suggested_tags?: string[] };
const groupOf = async (slug: string) => (await getSetting(db, "tags")).find((g) => g.tags.some((t) => t.slug === slug));

describe("tagOverview", () => {
  it("counts visible tools per tag, and lists suggestions and tags outside the vocabulary", async () => {
    await tool(["cli", "macos"]);
    await tool(["cli", "retired"], "published");
    await tool(["cli", "retired"], "hidden");
    await post({ tags: [], suggested_tags: ["kiro", "amp"] });
    await post({ tags: [], suggested_tags: ["kiro", "cli"] }, { status: "published" });
    await post({ tags: [], suggested_tags: ["ignored"] }, { status: "dropped" });
    const o = await tagOverview(db);
    expect(o.groups.map((g) => g.slug)).toEqual(["works-with", "models", "platform", "interface"]);
    expect(o.groups.find((g) => g.slug === "interface")!.tags.find((t) => t.slug === "cli")).toEqual({ slug: "cli", label: "CLI", tools: 2 });
    // "cli" is in the vocabulary, so it isn't offered as a suggestion.
    expect(o.suggestions).toEqual([{ tag: "kiro", posts: 2 }, { tag: "amp", posts: 1 }]);
    expect(o.orphans).toEqual([{ tag: "retired", tools: 1 }]);
    expect(await suggestedTags(db)).toContainEqual({ tag: "cli", posts: 1 });
  });
});

describe("addTag", () => {
  it("adds a tag last in its group and gives it to posts that suggested it, and their tools", async () => {
    const t = await tool(["cli"]);
    const p = await post({ tags: ["cli"], suggested_tags: ["llama.cpp", "other-thing"] }, { toolId: t });
    const untouched = await post({ tags: [], suggested_tags: ["amp"] });
    expect(await addTag(db, form({ label: "llama.cpp", slug: "", group: "models", suggestion: "llama.cpp" }))).toBe("llama-cpp");
    expect((await groupOf("llama-cpp"))!.tags.at(-1)).toEqual({ slug: "llama-cpp", label: "llama.cpp" });
    expect(await classification(p)).toMatchObject({ tags: ["cli", "llama-cpp"], suggested_tags: ["other-thing"] });
    expect(await toolTags(t)).toEqual(["cli", "llama-cpp"]);
    expect(await classification(untouched)).toMatchObject({ tags: [], suggested_tags: ["amp"] });
  });

  it("refuses a duplicate slug, a blank label and an unknown group", async () => {
    await expect(addTag(db, form({ label: "CLI", slug: "cli", group: "interface" }))).rejects.toThrow("already a tag");
    await expect(addTag(db, form({ label: " ", slug: "x", group: "interface" }))).rejects.toThrow("label");
    await expect(addTag(db, form({ label: "X", slug: "x", group: "nope" }))).rejects.toThrow("group");
    // tags/new.astro would shadow its edit page.
    await expect(addTag(db, form({ label: "New", slug: "", group: "interface" }))).rejects.toThrow("reserved");
    await expect(updateTag(db, "cli", form({ label: "CLI", slug: "new", group: "interface" }))).rejects.toThrow("reserved");
    expect((await loadTagSettings(db)).stored).toBe(original);
  });
});

describe("updateTag", () => {
  it("renames in place, moving tools, posts and review corrections", async () => {
    const t = await tool(["macos", "cli", "linux"]);
    const p = await post({ tags: ["cli"] }, { toolId: t });
    await db.prepare("INSERT INTO review_decisions (post_id, decision, corrected_fields, decided_at) VALUES (?, 'edit', ?, '2026-10-02T00:00:00Z')").bind(p, '{"tags":["cli","macos"]}').run();
    const before = (await groupOf("cli"))!.tags.findIndex((x) => x.slug === "cli");
    expect(await updateTag(db, "cli", form({ label: "Terminal", slug: "terminal", group: "interface" }))).toBe("terminal");
    const group = (await groupOf("terminal"))!;
    expect(group.tags[before]).toEqual({ slug: "terminal", label: "Terminal" });
    expect(await toolTags(t)).toEqual(["macos", "terminal", "linux"]);
    expect((await classification(p)).tags).toEqual(["terminal"]);
    const d = await db.prepare("SELECT corrected_fields FROM review_decisions WHERE post_id = ?").bind(p).first<{ corrected_fields: string }>();
    expect(JSON.parse(d!.corrected_fields).tags).toEqual(["terminal", "macos"]);
  });

  it("moves a tag to the end of another group, and drops a group left empty", async () => {
    await updateTag(db, "docker", form({ label: "Docker", slug: "docker", group: "interface" }));
    expect((await groupOf("docker"))!.slug).toBe("interface");
    expect((await groupOf("docker"))!.tags.at(-1)!.slug).toBe("docker");
    // Moving into an earlier group keeps the label change too.
    await updateTag(db, "docker", form({ label: "Docker image", slug: "docker", group: "works-with" }));
    expect((await groupOf("docker"))!.tags.at(-1)).toEqual({ slug: "docker", label: "Docker image" });
    expect((await getSetting(db, "tags")).flatMap((g) => g.tags).filter((x) => x.slug === "docker")).toHaveLength(1);

    const read = await loadTagSettings(db);
    const solo = read.groups.map((g) => (g.slug === "platform" ? { ...g, tags: [{ slug: "macos", label: "macOS" }] } : g));
    await saveTagSettings(db, read, solo);
    await updateTag(db, "macos", form({ label: "macOS", slug: "macos", group: "interface" }));
    expect((await getSetting(db, "tags")).map((g) => g.slug)).not.toContain("platform");
  });

  it("refuses renaming onto an existing tag", async () => {
    await expect(updateTag(db, "cli", form({ label: "CLI", slug: "macos", group: "interface" }))).rejects.toThrow("Merge");
    await expect(updateTag(db, "nope", form({ label: "X", slug: "x", group: "interface" }))).rejects.toThrow("not a tag");
  });
});

describe("mergeTag and deleteTag", () => {
  it("merge swaps the tag for another, without duplicates, and removes it", async () => {
    const both = await tool(["windsurf", "cursor", "cli"]);
    const one = await tool(["windsurf"]);
    const p = await post({ tags: ["windsurf"] });
    await mergeTag(db, "windsurf", "cursor");
    expect(await groupOf("windsurf")).toBeUndefined();
    expect(await toolTags(both)).toEqual(["cursor", "cli"]);
    expect(await toolTags(one)).toEqual(["cursor"]);
    expect((await classification(p)).tags).toEqual(["cursor"]);
  });

  it("delete takes the tag off everything and keeps the rest in order", async () => {
    const t = await tool(["macos", "windows", "linux"]);
    const p = await post({ tags: ["windows"] });
    await deleteTag(db, "windows");
    expect(await groupOf("windows")).toBeUndefined();
    expect(await toolTags(t)).toEqual(["macos", "linux"]);
    expect((await classification(p)).tags).toEqual([]);
  });

  it("refuses merging into itself or an unknown tag", async () => {
    await expect(mergeTag(db, "cli", "cli")).rejects.toThrow("different");
    await expect(mergeTag(db, "cli", "nope")).rejects.toThrow("Pick a tag");
  });
});

describe("mapTag", () => {
  it("gives a suggestion's posts and tools an existing tag, or dismisses it", async () => {
    const t = await tool(["cli"]);
    const p = await post({ tags: ["cli"], suggested_tags: ["claude-code-plugin"] }, { toolId: t });
    const dropped = await post({ tags: [], suggested_tags: ["python"] });
    await mapTag(db, "claude-code-plugin", "plugin");
    expect(await classification(p)).toMatchObject({ tags: ["cli", "plugin"], suggested_tags: [] });
    expect(await toolTags(t)).toEqual(["cli", "plugin"]);
    await mapTag(db, "python", null);
    expect(await classification(dropped)).toMatchObject({ tags: [], suggested_tags: [] });
    expect((await loadTagSettings(db)).stored).toBe(original);
  });

  it("maps a tag left on tools, in any case", async () => {
    const t = await tool(["retired", "cli"]);
    const mixed = await tool(["Old-Tag"]);
    const p = await post({ tags: ["Old-Tag"], suggested_tags: ["old-tag"] }, { toolId: mixed });
    await mapTag(db, "retired", "cli");
    expect(await toolTags(t)).toEqual(["cli"]);
    await mapTag(db, "Old-Tag", "macos");
    expect(await toolTags(mixed)).toEqual(["macos"]);
    expect(await classification(p)).toMatchObject({ tags: ["macos"], suggested_tags: [] });
  });

  it("refuses a vocabulary tag or an unknown target", async () => {
    await expect(mapTag(db, "cli", "macos")).rejects.toThrow("in your tag list");
    await expect(mapTag(db, "kiro", "nope")).rejects.toThrow("from your list");
  });
});

describe("ordering", () => {
  it("moves tags within their group and groups among themselves", async () => {
    expect(canMoveIn(["a", "b"], "a", "up")).toBe(false);
    expect(canMoveIn(["a", "b"], "a", "down")).toBe(true);
    expect(canMoveIn(["a", "b"], "nope", "down")).toBe(false);
    await expect(reorderGroup(db, "nope", "up")).rejects.toThrow("not a group");
    const first = (await getSetting(db, "tags"))[0]!;
    await reorderTag(db, first.tags[1]!.slug, "up");
    expect((await getSetting(db, "tags"))[0]!.tags.slice(0, 2).map((t) => t.slug)).toEqual([first.tags[1]!.slug, first.tags[0]!.slug]);
    await reorderGroup(db, "models", "up");
    expect((await getSetting(db, "tags")).map((g) => g.slug).slice(0, 2)).toEqual(["models", "works-with"]);
  });
});

describe("groups", () => {
  it("adds a group with its first tag, and edits its name and hint", async () => {
    const p = await post({ tags: [], suggested_tags: ["vim"] });
    expect(await addGroup(db, form({ label: "Editors", hint: "", tag_label: "Vim", tag_slug: "" }))).toBe("editors");
    expect((await getSetting(db, "tags")).at(-1)).toEqual({ slug: "editors", label: "Editors", hint: "", tags: [{ slug: "vim", label: "Vim" }] });
    expect((await classification(p)).tags).toEqual(["vim"]);
    await updateGroup(db, "editors", form({ label: "Text editors", hint: "the editor it runs in" }));
    expect((await getSetting(db, "tags")).at(-1)).toMatchObject({ slug: "editors", label: "Text editors", hint: "the editor it runs in" });
  });

  it("refuses an empty group, a duplicate name or a tag already in the list", async () => {
    await expect(addGroup(db, form({ label: "Editors", hint: "", tag_label: "", tag_slug: "" }))).rejects.toThrow("first tag");
    await expect(addGroup(db, form({ label: "Models", hint: "", tag_label: "X", tag_slug: "" }))).rejects.toThrow("already");
    await expect(addGroup(db, form({ label: "Editors", hint: "", tag_label: "CLI", tag_slug: "cli" }))).rejects.toThrow("already a tag");
    await expect(addGroup(db, form({ label: "New", hint: "", tag_label: "X", tag_slug: "" }))).rejects.toThrow("reserved");
    await expect(addGroup(db, form({ label: "Editors", hint: "", tag_label: "New", tag_slug: "" }))).rejects.toThrow("reserved");
  });
});

describe("saveTagSettings", () => {
  it("changes nothing and throws when the vocabulary changed after it was read", async () => {
    const t = await tool(["cli"]);
    const read = await loadTagSettings(db);
    await reorderGroup(db, "models", "up");
    const after = (await loadTagSettings(db)).stored;
    await expect(saveTagSettings(db, read, read.groups, [{ from: "cli", into: null }])).rejects.toThrow("changed somewhere else");
    expect((await loadTagSettings(db)).stored).toBe(after);
    expect(await toolTags(t)).toEqual(["cli"]);
  });
});
