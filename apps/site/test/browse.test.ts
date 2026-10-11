import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { browse, filterParams, highlightHtml, parseFilters } from "../src/lib/browse.ts";

const db = env.DB;
const groups = [
  { slug: "works-with", label: "Works with", hint: "", tags: [{ slug: "claude-code", label: "Claude Code" }, { slug: "codex", label: "Codex" }] },
  { slug: "platform", label: "Platform", hint: "", tags: [{ slug: "macos", label: "macOS" }, { slug: "linux", label: "Linux" }] },
];

beforeEach(async () => {
  await db.batch(["post_snapshots", "repo_snapshots", "tool_aliases", "posts", "tools"].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

let n = 0;
async function tool(
  name: string,
  o: { description?: string; category?: string; tags?: string[]; open?: number | null; score?: number; seen?: string; stars?: number; lang?: string; status?: string } = {},
) {
  const row = await db
    .prepare(
      `INSERT INTO tools (slug, name, description, category, tags, is_open_source, status, trending_score, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) RETURNING id`,
    )
    .bind(`${name.toLowerCase().replace(/\W+/g, "-")}-${++n}`, name, o.description ?? `${name} does things`, o.category ?? "agent", JSON.stringify(o.tags ?? []),
      o.open === undefined ? 1 : o.open, o.status ?? "published", o.score ?? 0, o.seen ?? null)
    .first<{ id: number }>();
  if (o.stars !== undefined) {
    await db.batch([
      db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars, language) VALUES (?, date('now', '-1 day'), 1, 'Old')").bind(row!.id),
      db.prepare("INSERT INTO repo_snapshots (tool_id, date, stars, language) VALUES (?, date('now'), ?, ?)").bind(row!.id, o.stars, o.lang ?? null),
    ]);
  }
  return row!.id;
}
const run = (query: string, defaultSort?: "trending" | "new") => browse(db, parseFilters(new URLSearchParams(query), defaultSort), groups);
const names = async (query: string, defaultSort?: "trending" | "new") => (await run(query, defaultSort)).tools.map((t) => t.name);

describe("parseFilters", () => {
  it("keeps valid values and drops the rest", () => {
    const f = parseFilters(new URLSearchParams("q=+git+&category=agent&category=Bad!&tag=macos&tag=macos&license=open&stars=100&lang=Rust&seen=30&sort=stars&page=2"));
    expect(f).toEqual({ q: "git", categories: ["agent"], tags: ["macos"], license: "open", stars: 100, langs: ["Rust"], seen: 30, sort: "stars", page: 2 });
    expect(parseFilters(new URLSearchParams("license=maybe&stars=50&seen=3&sort=nope"))).toMatchObject({ license: "", stars: 0, seen: 0, sort: "trending" });
  });

  it("defaults to best match with a query, and only allows it with one", () => {
    expect(parseFilters(new URLSearchParams("q=worktree")).sort).toBe("best");
    expect(parseFilters(new URLSearchParams("sort=best")).sort).toBe("trending");
    expect(parseFilters(new URLSearchParams("q=%21%21"), "new").sort).toBe("new");
  });

  it("round-trips through filterParams, leaving out defaults", () => {
    const query = "q=git&category=agent&tag=macos&license=closed&stars=10&lang=Go&seen=7&sort=stars&page=3";
    expect(filterParams(parseFilters(new URLSearchParams(query)), "trending").toString()).toBe(query);
    expect(filterParams(parseFilters(new URLSearchParams("sort=new")), "new").toString()).toBe("");
  });
});

describe("browse", () => {
  it("filters by category, tags (any within a group, all groups), license, stars, language and first seen", async () => {
    await tool("Alpha", { category: "cli", tags: ["claude-code", "macos"], stars: 500, lang: "Rust", score: 3 });
    await tool("Beta", { category: "agent", tags: ["codex", "linux"], open: 0, score: 2 });
    await tool("Gamma", { category: "agent", tags: ["claude-code", "linux"], stars: 20, lang: "Go", seen: "2026-01-01T00:00:00.000Z", score: 1 });
    await tool("Hidden", { status: "hidden", tags: ["claude-code"] });

    expect(await names("")).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(await names("category=agent")).toEqual(["Beta", "Gamma"]);
    expect(await names("tag=claude-code&tag=codex")).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(await names("tag=claude-code&tag=linux")).toEqual(["Gamma"]);
    expect(await names("license=closed")).toEqual(["Beta"]);
    expect(await names("stars=100")).toEqual(["Alpha"]);
    expect(await names("lang=Go")).toEqual(["Gamma"]);
    expect(await names("seen=30")).toEqual(["Alpha", "Beta"]);
  });

  it("counts each facet over the other filters only", async () => {
    await tool("Alpha", { category: "cli", tags: ["claude-code", "macos"], stars: 500, lang: "Rust" });
    await tool("Beta", { category: "agent", tags: ["codex"], open: 0 });
    await tool("Gamma", { category: "agent", tags: ["claude-code"], stars: 20, lang: "Go" });

    const { facets, total } = await run("category=agent&tag=claude-code");
    expect(total).toBe(1);
    // Categories ignore the category filter but keep the tag filter.
    expect(Object.fromEntries(facets.categories)).toEqual({ cli: 1, agent: 1 });
    // Works-with ignores its own tag filter, keeps the category filter.
    expect(facets.tags.get("claude-code")).toBe(1);
    expect(facets.tags.get("codex")).toBe(1);
    expect(facets.tags.get("macos")).toBeUndefined();
    expect(facets.license).toEqual({ open: 1, closed: 0 });
    expect(facets.stars.get(10)).toBe(1);
    expect(facets.stars.get(100)).toBe(0);
    expect(facets.langs).toEqual([["Go", 1]]);
    expect(facets.seen.get(7)).toBe(1);
  });

  it("sorts by trending, newest, stars and posts", async () => {
    await tool("Old", { score: 9, seen: "2026-01-01T00:00:00.000Z", stars: 5 });
    const b = await tool("Fresh", { score: 1, stars: 900 });
    await tool("Mid", { score: 5, seen: "2026-06-01T00:00:00.000Z" });
    await db
      .prepare("INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, tool_id) VALUES ('hn', 'x', 'https://x', 'https://x', 't', '2026-10-01', 'published', ?)")
      .bind(b)
      .run();
    expect(await names("")).toEqual(["Old", "Mid", "Fresh"]);
    expect(await names("", "new")).toEqual(["Fresh", "Mid", "Old"]);
    expect(await names("sort=stars")).toEqual(["Fresh", "Old", "Mid"]);
    expect(await names("sort=discussed")).toEqual(["Fresh", "Old", "Mid"]);
  });

  it("searches names, descriptions and tags, ranks name matches first, and highlights safely", async () => {
    await tool("Worktrunk", { description: "Git worktrees for <agents>", score: 1 });
    await tool("Hall Monitor", { description: "Watches your worktree changes", score: 9 });
    await tool("Patchwork", { description: "Reviews pull requests", tags: ["worktree-ish"] });
    await tool("Other", { description: "Nothing here" });

    const { tools, total } = await run("q=worktr");
    expect(total).toBe(3);
    expect(tools.map((t) => t.name)).toEqual(["Worktrunk", "Hall Monitor", "Patchwork"]);
    expect(tools[0]!.nameHtml).toMatch(/^<mark[^>]*>Worktrunk<\/mark>$/);
    expect(tools[0]!.descriptionHtml).toContain("&lt;agents&gt;");
    expect(tools[1]!.nameHtml).toBe("Hall Monitor");
    expect(tools[1]!.descriptionHtml).toMatch(/<mark[^>]*>worktree<\/mark> changes/);
    // FTS syntax in the query is ignored, not executed.
    expect((await run('q=" OR name:*')).total).toBe(0);
  });

  it("pages by PAGE_SIZE", async () => {
    for (let i = 0; i < 26; i++) await tool(`T${i}`, { score: 100 - i });
    expect((await run("")).tools).toHaveLength(25);
    expect(await names("page=2")).toEqual(["T25"]);
  });
});

describe("highlightHtml", () => {
  it("escapes text and keeps only the match markers as markup", () => {
    expect(highlightHtml('a <b> & "c" \u0001x\u0002')).toBe('a &lt;b&gt; &amp; &quot;c&quot; <mark class="bg-lime-50 text-inherit shadow-[inset_0_-2px_0_var(--color-lime-400)] dark:bg-lime-400/15">x</mark>');
  });
});

describe("chips and links", () => {
  it("links to the same page without each filter, back on page 1", async () => {
    const { activeChips, browseHref } = await import("../src/lib/browse.ts");
    const f = parseFilters(new URLSearchParams("q=git&category=agent&category=cli&tag=macos&stars=1000&seen=7&page=3"));
    const chips = activeChips("/search", f, "trending", { category: (c) => c.toUpperCase(), tag: (t) => `#${t}` });
    expect(chips).toEqual([
      { label: "AGENT", href: "/search?q=git&category=cli&tag=macos&stars=1000&seen=7" },
      { label: "CLI", href: "/search?q=git&category=agent&tag=macos&stars=1000&seen=7" },
      { label: "#macos", href: "/search?q=git&category=agent&category=cli&stars=1000&seen=7" },
      { label: "1k+ stars", href: "/search?q=git&category=agent&category=cli&tag=macos&seen=7" },
      { label: "First seen in the last 7 days", href: "/search?q=git&category=agent&category=cli&tag=macos&stars=1000" },
    ]);
    expect(browseHref("/", parseFilters(new URLSearchParams("page=4")), "trending")).toBe("/");
    expect(browseHref("/search", parseFilters(new URLSearchParams("q=git&sort=trending")), "trending")).toBe("/search?q=git&sort=trending");
  });
});
