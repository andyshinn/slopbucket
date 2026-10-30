import { PUBLISHABLE_QUEUED_SQL, SETTING_KEYS, type SettingKey, type TagGroups, autoPublishes, settingSchemas } from "@slop-bucket/core";

export type FieldKind = "number" | "integer" | "text" | "lines" | "weights" | "reasoning" | "taggroups";

export interface SettingField {
  key: SettingKey;
  label: string;
  help: string;
  kind: FieldKind;
  /** Shown after a save: what the change applies to, and how to apply it to existing posts. */
  afterSave: { text: string; link?: { href: string; label: string } };
}

// What a change needs before it reaches posts already stored. Only the classifier
// settings need the model again; the rest apply from stored data or the next job.
const RECLASSIFY: SettingField["afterSave"] = {
  text: "New posts use it now. Posts already in the queue keep their result until you re-classify them (this calls the model).",
  link: { href: "/admin/status#jobs-h", label: "Status → Jobs" },
};
const NEXT_FETCH: SettingField["afterSave"] = { text: "Applies from the next fetch. Posts already stored stay as they are." };

/** How each setting is edited on /admin/settings, in display order. */
export const SETTING_FIELDS: SettingField[] = [
  { key: "review_threshold", label: "Review threshold", help: "Posts at or above this confidence publish automatically. 1 sends everything to review.", kind: "number",
    afterSave: {
      text: "New posts use it now. To apply it to the queue from stored confidence (no model calls), use Publish confident posts.",
      link: { href: "/admin/status#jobs-h", label: "Status → Jobs" },
    },
  },
  { key: "model_id", label: "Classifier model", help: "Workers AI model ID. Score a model with the Eval workflow before switching.", kind: "text", afterSave: RECLASSIFY },
  { key: "model_reasoning_effort", label: "Reasoning effort", help: "For reasoning models. Empty sends none.", kind: "reasoning", afterSave: RECLASSIFY },
  { key: "prefilter_keywords", label: "Pre-filter keywords", help: "One per line. A post needs at least one hit (or a GitHub link, Show HN, or an AI tag on lobste.rs) to be classified.", kind: "lines", afterSave: NEXT_FETCH },
  { key: "max_fewshot", label: "Few-shot examples", help: "Most review decisions marked as examples that go into the prompt.", kind: "integer", afterSave: RECLASSIFY },
  { key: "github_topics", label: "GitHub topics", help: "One per line. Repos with any of these topics are searched daily.", kind: "lines", afterSave: NEXT_FETCH },
  { key: "github_min_stars", label: "GitHub minimum stars", help: "Repos need at least this many stars to be classified.", kind: "integer", afterSave: NEXT_FETCH },
  {
    key: "tags",
    label: "Tags",
    help: 'A "# Group | what it means" line starts each group, then one "slug: Label" per line. The classifier may only use these.',
    kind: "taggroups",
    afterSave: RECLASSIFY,
  },
  { key: "trending_weights", label: "Trending weights", help: "Source weight, engagement weight, star-growth weight and gravity exponent.", kind: "weights",
    afterSave: { text: "Scores use it at the next daily update, or run it now.", link: { href: "/admin/status#trending-h", label: "Status → Trending" } },
  },
];

/** Settings edited on /admin/taxonomy instead, since a change there may also rewrite tools and posts. */
export const TAXONOMY_KEYS: readonly SettingKey[] = ["categories", "category_info"];

// Keep the page in sync with the schema: every setting must have a field or live on the taxonomy page.
for (const key of SETTING_KEYS) {
  if (!SETTING_FIELDS.some((f) => f.key === key) && !TAXONOMY_KEYS.includes(key)) throw new Error(`No admin field for setting ${key}`);
}

export const REASONING_LEVELS = ["", "none", "low", "medium", "high"] as const;
export const WEIGHT_KEYS = ["w_s", "w_e", "w_g", "g"] as const;

export async function loadSettings(db: D1Database): Promise<Record<string, unknown>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)]));
}

/** Form fields for one setting -> its JSON value (before validation). */
export function parseSettingForm(field: SettingField, form: FormData): unknown {
  const str = (name = "value") => String(form.get(name) ?? "").trim();
  switch (field.kind) {
    case "number":
    case "integer":
      return str() === "" ? NaN : Number(str());
    case "text":
    case "reasoning":
      return str();
    case "lines":
      return str()
        .split(/[\n,]/)
        .map((l) => l.trim())
        .filter(Boolean);
    case "weights":
      return Object.fromEntries(WEIGHT_KEYS.map((k) => [k, str(k) === "" ? NaN : Number(str(k))]));
    case "taggroups":
      return parseTagGroups(String(form.get("value") ?? ""));
  }
}

export class SettingError extends Error {}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The tags setting as editable text: "# Group | hint" headers, then "slug: Label" lines. */
export function formatTagGroups(groups: TagGroups): string {
  return groups
    .map((g) => [`# ${g.label}${g.hint ? ` | ${g.hint}` : ""}`, ...g.tags.map((t) => `${t.slug}: ${t.label}`)].join("\n"))
    .join("\n\n");
}

/** Inverse of formatTagGroups. A bare "slug" line uses the slug as its label. */
export function parseTagGroups(text: string): unknown {
  const groups: { slug: string; label: string; hint: string; tags: { slug: string; label: string }[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const [label = "", hint = ""] = line.replace(/^#+/, "").split("|").map((p) => p.trim());
      groups.push({ slug: slugify(label), label, hint, tags: [] });
      continue;
    }
    const group = groups.at(-1);
    if (!group) throw new SettingError(`"${line}" comes before any "# Group" line.`);
    const [slug = "", ...rest] = line.split(":");
    const label = rest.join(":").trim();
    group.tags.push({ slug: slug.trim(), label: label || slug.trim() });
  }
  return groups;
}

/** Tags the classifier asked for that are not in the vocabulary, most requested first. */
export async function suggestedTags(db: D1Database, limit = 20): Promise<{ tag: string; n: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT lower(j.value) AS tag, count(*) AS n
       FROM posts p, json_each(p.classification, '$.suggested_tags') j
       WHERE p.status IN ('queued', 'published') AND p.classification IS NOT NULL
       GROUP BY 1 ORDER BY n DESC, tag LIMIT ?`,
    )
    .bind(limit)
    .all<{ tag: string; n: number }>();
  return results;
}

export interface ThresholdBucket {
  /** Lower edge, 0 to 0.9 in steps of 0.1; the top bucket also holds 1.0. */
  from: number;
  /** Queued posts with a score in this bucket. */
  posts: number;
  /** Of those, posts in "other", which never auto-publish. */
  other: number;
  /** Of those, posts Publish confident posts would publish at the current threshold. */
  publishNow: number;
  /** Queued posts Publish confident posts would publish at a threshold of `from`. */
  publishAt: number;
}

export interface ThresholdHistogram {
  /** Highest bucket first. */
  buckets: ThresholdBucket[];
  /** Queued posts without a score (invalid model output); they always stay in review. */
  noScore: number;
  /** Scored posts, not "other", that it never publishes: already reviewed, or a category since removed. */
  held: number;
  queued: number;
  /** Queued posts Publish confident posts would publish at the current threshold. */
  publishAtCurrent: number;
}

export interface QueuedScore {
  confidence: number | null;
  category: string | null;
  /** Matches PUBLISHABLE_QUEUED_SQL: Publish confident posts may publish it at some threshold. */
  eligible: 0 | 1 | null;
  n: number;
}

/** Queued posts grouped by exact score, category and eligibility, for thresholdHistogram(). */
export async function queuedScores(db: D1Database): Promise<QueuedScore[]> {
  const { results } = await db
    .prepare(
      `SELECT confidence, json_extract(classification, '$.category') AS category, (${PUBLISHABLE_QUEUED_SQL}) AS eligible, count(*) AS n
       FROM posts WHERE status = 'queued' GROUP BY 1, 2, 3`,
    )
    .all<QueuedScore>();
  return results;
}

/** Bucket edges above 0; a score's bucket is how many it is at or above. */
const EDGES = Array.from({ length: 9 }, (_, k) => (k + 1) / 10);

/**
 * Queued posts in 0.1 buckets of stored confidence, with how many Publish confident
 * posts would publish at each threshold (the same posts and rule as PUBLISH_CONFIDENT_SQL).
 */
export function thresholdHistogram(rows: QueuedScore[], threshold: number): ThresholdHistogram {
  const buckets = Array.from({ length: 10 }, (_, b) => ({ from: b / 10, posts: 0, other: 0, publishNow: 0, publishAt: 0, publishable: 0 }));
  let noScore = 0;
  let held = 0;
  let queued = 0;
  for (const r of rows) {
    queued += r.n;
    if (r.confidence === null) {
      noScore += r.n;
      continue;
    }
    // The same >= comparison as the threshold (exact decimal edges), so a score of 0.8 sits in
    // 0.8–0.9 and publishes at 0.8. 1.0 is at or above every edge, so it lands in the top bucket.
    const confidence = r.confidence;
    const bucket = buckets[EDGES.filter((e) => confidence >= e).length]!;
    bucket.posts += r.n;
    if (r.category === "other") bucket.other += r.n;
    else if (r.eligible !== 1) held += r.n;
    else {
      // At the bucket's own low edge (below 1, not "other") autoPublishes() holds for every such post.
      bucket.publishable += r.n;
      if (autoPublishes(threshold, confidence, r.category ?? "")) bucket.publishNow += r.n;
    }
  }
  // A threshold at a bucket's low edge publishes that bucket and every one above it.
  let above = 0;
  for (let b = buckets.length - 1; b >= 0; b--) buckets[b]!.publishAt = above += buckets[b]!.publishable;
  return {
    buckets: buckets.reverse().map(({ publishable: _, ...b }) => b),
    noScore,
    held,
    queued,
    publishAtCurrent: buckets.reduce((n, b) => n + b.publishNow, 0),
  };
}

/** Validates with the same schema the Worker uses, then saves. */
export async function saveSetting(db: D1Database, key: string, form: FormData): Promise<void> {
  const field = SETTING_FIELDS.find((f) => f.key === key);
  if (!field) throw new SettingError("Unknown setting.");
  const parsed = settingSchemas[field.key].safeParse(parseSettingForm(field, form));
  if (!parsed.success) {
    throw new SettingError(parsed.error.issues.map((i) => (i.path.length && field.kind === "taggroups" ? `${describePath(form, i.path)}: ${i.message}` : i.message)).join("; "));
  }
  if (field.kind === "integer" && !Number.isInteger(parsed.data)) throw new SettingError("Must be a whole number.");
  if (field.kind === "reasoning" && !(REASONING_LEVELS as readonly string[]).includes(parsed.data as string)) {
    throw new SettingError(`Must be one of: ${REASONING_LEVELS.filter(Boolean).join(", ")}, or empty.`);
  }
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(field.key, JSON.stringify(parsed.data))
    .run();
}

/** "Works with, tag 3" for a tag-groups validation error path like [0, "tags", 2, "slug"]. */
function describePath(form: FormData, path: PropertyKey[]): string {
  const groups = parseTagGroups(String(form.get("value") ?? "")) as { label: string; tags: { slug: string }[] }[];
  const group = typeof path[0] === "number" ? groups[path[0]] : undefined;
  if (!group) return "Tags";
  const tag = path[1] === "tags" && typeof path[2] === "number" ? group.tags[path[2]] : undefined;
  return tag ? `${group.label}, "${tag.slug}"` : group.label || "Group";
}
