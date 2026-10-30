import { env } from "cloudflare:workers";
import { getSetting } from "@slop-bucket/core";
import { describe, expect, it } from "vitest";
import { SETTING_FIELDS, SettingError, formatTagGroups, loadSettings, saveSetting, suggestedTags, thresholdHistogram, wouldPublish } from "../src/lib/settings-admin.ts";

const db = env.DB;
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("saveSetting", () => {
  it("covers every setting key", async () => {
    const stored = await loadSettings(db);
    expect(SETTING_FIELDS.map((f) => f.key).sort()).toEqual(Object.keys(stored).sort());
  });

  it("saves numbers, lines, weights and reasoning levels", async () => {
    await saveSetting(db, "review_threshold", form({ value: "0.85" }));
    expect(await getSetting(db, "review_threshold")).toBe(0.85);

    await saveSetting(db, "github_topics", form({ value: " mcp\nclaude-code \n\n ai-agents" }));
    expect(await getSetting(db, "github_topics")).toEqual(["mcp", "claude-code", "ai-agents"]);

    await saveSetting(db, "trending_weights", form({ w_s: "2", w_e: "1", w_g: "0.5", g: "1.8" }));
    expect(await getSetting(db, "trending_weights")).toEqual({ w_s: 2, w_e: 1, w_g: 0.5, g: 1.8 });

    await saveSetting(db, "model_reasoning_effort", form({ value: "" }));
    expect(await getSetting(db, "model_reasoning_effort")).toBe("");
    await saveSetting(db, "model_reasoning_effort", form({ value: "low" }));
  });

  it.each([
    ["review_threshold", { value: "1.5" }],
    ["review_threshold", { value: "" }],
    ["max_fewshot", { value: "2.5" }],
    ["github_min_stars", { value: "-1" }],
    ["categories", { value: "agent\ncli" }], // missing "other"
    ["categories", { value: "Agent\nother" }], // not lowercase
    ["categories", { value: "cli\ncli\nother" }],
    ["model_id", { value: "" }],
    ["model_reasoning_effort", { value: "extreme" }],
    ["trending_weights", { w_s: "1", w_e: "1", w_g: "", g: "1" }],
    ["no_such_setting", { value: "1" }],
  ])("rejects %s = %j", async (key, entries) => {
    const before = await loadSettings(db);
    await expect(saveSetting(db, key, form(entries))).rejects.toBeInstanceOf(SettingError);
    expect(await loadSettings(db)).toEqual(before);
  });
});

describe("tags setting", () => {
  it("round-trips the seeded vocabulary through the text format", async () => {
    const seeded = await getSetting(db, "tags");
    expect(seeded.map((g) => g.slug)).toEqual(["works-with", "models", "platform", "interface"]);
    const text = formatTagGroups(seeded);
    expect(text).toContain("# Works with | the coding agent or editor it plugs into or drives\nclaude-code: Claude Code");
    await saveSetting(db, "tags", form({ value: text }));
    expect(await getSetting(db, "tags")).toEqual(seeded);
  });

  it("parses groups and tags, and rejects duplicates and bad slugs with a pointer", async () => {
    const original = await getSetting(db, "tags");
    try {
      await saveSetting(db, "tags", form({ value: "# Works with | host agent\nclaude-code: Claude Code\nkiro\n\n# Platform\nmacos: macOS" }));
      expect(await getSetting(db, "tags")).toEqual([
        { slug: "works-with", label: "Works with", hint: "host agent", tags: [{ slug: "claude-code", label: "Claude Code" }, { slug: "kiro", label: "kiro" }] },
        { slug: "platform", label: "Platform", hint: "", tags: [{ slug: "macos", label: "macOS" }] },
      ]);
      await expect(saveSetting(db, "tags", form({ value: "# A\nx\n# B\nx" }))).rejects.toThrow("only once");
      await expect(saveSetting(db, "tags", form({ value: "# Works with\nClaude Code" }))).rejects.toThrow('Works with, "Claude Code"');
      await expect(saveSetting(db, "tags", form({ value: "orphan: Orphan" }))).rejects.toThrow(SettingError);
    } finally {
      await db.prepare("UPDATE settings SET value = ? WHERE key = 'tags'").bind(JSON.stringify(original)).run();
    }
  });

  it("lists tags the classifier suggested", async () => {
    await db.prepare("DELETE FROM posts").run();
    await db
      .prepare(
        `INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, classification) VALUES
         ('hn', 's1', 'u', 'u', 't', '2026-10-01T00:00:00Z', 'queued', '{"suggested_tags":["kiro","amp"]}'),
         ('hn', 's2', 'u', 'u', 't', '2026-10-01T00:00:00Z', 'queued', '{"suggested_tags":["kiro"]}'),
         ('hn', 's3', 'u', 'u', 't', '2026-10-01T00:00:00Z', 'dropped', '{"suggested_tags":["ignored"]}')`,
      )
      .run();
    expect(await suggestedTags(db)).toEqual([{ tag: "kiro", n: 2 }, { tag: "amp", n: 1 }]);
    await db.prepare("DELETE FROM posts").run();
  });
});

describe("thresholdHistogram", () => {
  it("buckets queued posts by score and counts what each threshold would publish", async () => {
    await db.prepare("DELETE FROM posts").run();
    const rows: [number | null, string, string][] = [
      [1, "cli", "queued"],
      [0.95, "agent", "queued"],
      [0.9, "other", "queued"], // never auto-publishes
      [0.85, "cli", "queued"],
      [0.8, "cli", "queued"], // the bucket's low edge belongs to it
      [0.8, "ide", "queued"],
      [0.3, "cli", "queued"],
      [null, "cli", "queued"], // invalid model output
      [0.99, "cli", "published"], // not in the queue
    ];
    await db.batch(
      rows.map(([confidence, category, status], i) =>
        db
          .prepare(
            `INSERT INTO posts (source, external_id, url, canonical_url, title, posted_at, status, confidence, classification)
             VALUES ('hn', ?, 'u', 'u', 't', '2026-10-01T00:00:00Z', ?, ?, ?)`,
          )
          .bind(`h${i}`, status, confidence, JSON.stringify({ category })),
      ),
    );

    const h = await thresholdHistogram(db, 0.85);
    expect(h.queued).toBe(8);
    expect(h.noScore).toBe(1);
    expect(h.publishAtCurrent).toBe(3);
    const at = (from: number) => h.buckets.find((b) => b.from === from);
    expect(h.buckets.map((b) => b.from)).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0]);
    expect(at(0.9)).toEqual({ from: 0.9, posts: 3, other: 1, publishNow: 2, publishAt: 2 });
    expect(at(0.8)).toEqual({ from: 0.8, posts: 3, other: 0, publishNow: 1, publishAt: 5 });
    expect(at(0.7)).toEqual({ from: 0.7, posts: 0, other: 0, publishNow: 0, publishAt: 5 });
    expect(at(0.3)).toEqual({ from: 0.3, posts: 1, other: 0, publishNow: 0, publishAt: 6 });
    expect(at(0)?.publishAt).toBe(6);

    expect((await thresholdHistogram(db, 1)).publishAtCurrent).toBe(0);
    await db.prepare("DELETE FROM posts").run();
  });

  it("matches the classifier's publish rule", () => {
    expect(wouldPublish(0.9, "cli", 0.9)).toBe(true);
    expect(wouldPublish(0.89, "cli", 0.9)).toBe(false);
    expect(wouldPublish(1, "cli", 1)).toBe(false);
    expect(wouldPublish(1, "other", 0)).toBe(false);
  });
});
