import { SETTING_KEYS, type SettingKey, type TagGroups, settingSchemas } from "@slop-bucket/core";

export type FieldKind = "number" | "integer" | "text" | "lines" | "weights" | "reasoning" | "taggroups";

export interface SettingField {
  key: SettingKey;
  label: string;
  help: string;
  kind: FieldKind;
}

/** How each setting is edited on /admin/settings, in display order. */
export const SETTING_FIELDS: SettingField[] = [
  { key: "review_threshold", label: "Review threshold", help: "Posts at or above this confidence publish automatically. 1 sends everything to review.", kind: "number" },
  { key: "model_id", label: "Classifier model", help: "Workers AI model ID. Score a model with the Eval workflow before switching.", kind: "text" },
  { key: "model_reasoning_effort", label: "Reasoning effort", help: "For reasoning models. Empty sends none.", kind: "reasoning" },
  { key: "categories", label: "Categories", help: 'One per line, lowercase with hyphens. Must include "other".', kind: "lines" },
  { key: "prefilter_keywords", label: "Pre-filter keywords", help: "One per line. A post needs at least one hit (or a GitHub link, Show HN, or an AI tag on lobste.rs) to be classified.", kind: "lines" },
  { key: "max_fewshot", label: "Few-shot examples", help: "Most review decisions marked as examples that go into the prompt.", kind: "integer" },
  { key: "github_topics", label: "GitHub topics", help: "One per line. Repos with any of these topics are searched daily.", kind: "lines" },
  { key: "github_min_stars", label: "GitHub minimum stars", help: "Repos need at least this many stars to be classified.", kind: "integer" },
  {
    key: "tags",
    label: "Tags",
    help: 'A "# Group | what it means" line starts each group, then one "slug: Label" per line. The classifier may only use these.',
    kind: "taggroups",
  },
  { key: "trending_weights", label: "Trending weights", help: "Source weight, engagement weight, star-growth weight and gravity exponent.", kind: "weights" },
];

// Keep the page in sync with the schema: every setting must have a field.
for (const key of SETTING_KEYS) {
  if (!SETTING_FIELDS.some((f) => f.key === key)) throw new Error(`No admin field for setting ${key}`);
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
  /** Of those, posts that would auto-publish at the current threshold. */
  publishNow: number;
  /** Queued posts that would auto-publish at a threshold of `from`. */
  publishAt: number;
}

export interface ThresholdHistogram {
  /** Highest bucket first. */
  buckets: ThresholdBucket[];
  /** Queued posts without a score (invalid model output); they always stay in review. */
  noScore: number;
  queued: number;
  /** Queued posts that would auto-publish at the current threshold. */
  publishAtCurrent: number;
}

/**
 * Would a post auto-publish at this threshold? The same rule as the classifier's
 * routing (apps/ingest/src/classify-job.ts): below a threshold of 1, at or above it, not "other".
 */
export function wouldPublish(confidence: number, category: string | null, threshold: number): boolean {
  return threshold < 1 && confidence >= threshold && category !== "other";
}

/** Queued posts by stored confidence, in 0.1 buckets, with how many each threshold would publish. */
export async function thresholdHistogram(db: D1Database, threshold: number): Promise<ThresholdHistogram> {
  // Grouped by exact score so the comparisons run in JS, exactly as the classifier makes them.
  const { results } = await db
    .prepare(
      `SELECT confidence, json_extract(classification, '$.category') AS category, count(*) AS n
       FROM posts WHERE status = 'queued' GROUP BY 1, 2`,
    )
    .all<{ confidence: number | null; category: string | null; n: number }>();
  const scored = results.filter((r): r is typeof r & { confidence: number } => r.confidence !== null);
  const publishable = (t: number) => scored.reduce((sum, r) => sum + (wouldPublish(r.confidence, r.category, t) ? r.n : 0), 0);
  const buckets = Array.from({ length: 10 }, (_, i) => {
    const from = (9 - i) / 10;
    const to = (10 - i) / 10; // the top bucket has no upper edge, so it holds 1.0
    const inBucket = scored.filter((r) => r.confidence >= from && (i === 0 || r.confidence < to));
    return {
      from,
      posts: inBucket.reduce((sum, r) => sum + r.n, 0),
      other: inBucket.reduce((sum, r) => sum + (r.category === "other" ? r.n : 0), 0),
      publishNow: inBucket.reduce((sum, r) => sum + (wouldPublish(r.confidence, r.category, threshold) ? r.n : 0), 0),
      publishAt: publishable(from),
    };
  });
  const noScore = results.reduce((sum, r) => sum + (r.confidence === null ? r.n : 0), 0);
  return { buckets, noScore, queued: results.reduce((sum, r) => sum + r.n, 0), publishAtCurrent: publishable(threshold) };
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
